/**
 * Integration tests: main loop drives a real MQTT broker.
 *
 * Requires a Mosquitto broker on localhost:1883.
 * Start one with: docker compose up -d
 *
 * Base scenario (FROM=17:00, targetTime="12:00", targetKwh=5)
 * -----------------------------------------------------------
 * The planner selects 7 solar-free (0 €) slots at 10:00–11:45 on Apr 19
 * (see planner.test.ts for the detailed assertion).  The relay therefore sees:
 *
 *   ON  (17:00) — waitForStart plug-in detection
 *   OFF (17:00) — runCharging sleeps through the overnight gap
 *   ON  (10:00) — solar-free charge slot begins
 *   ON  (12:00) — relay stays ON after charging completes (battery-full wait)
 *
 * advanceToSolarWindow() encodes the common three-step prelude used by most
 * tests.  Tests that trigger a replan during the sleep skip the third step.
 *
 * Behaviours verified:
 *   - relay sequencing through a full charge session (baseline status-history test)
 *   - target-time override replans in all phases: during the overnight sleep,
 *     mid-slot (tightening keeps the relay ON, extending drops the current slot)
 *     and after midnight (rolls to the next day)
 *   - status messages are stable with no flicker between charge slots
 *   - plan resume honours persisted chargedKwh
 *   - no car power: relay stays ON and the loop waits without erroring
 *   - heating hold pauses/resumes the relay without spurious commands
 *   - Charge Now keeps the relay ON across slot boundaries and resets target
 *     state after the session
 *   - planner and slot accounting use live-detected charger power
 *   - targetKwh override ends the session early and resets after the session
 *   - charge level changes re-plan only before charging starts
 *   - weekly schedule edits update state topic, runtime plan and config
 *     write-back; retained schedule state is recovered at startup
 *   - charged_energy is published and the session summary reports cost/solar%
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MqttRelaySimulator } from "./helpers/mqtt-relay-simulator.ts";
import { loadConfig } from "../src/config.ts";

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

const { FROM, SPEEDUP } = await import("./helpers/config.ts");
const { startMqttSession } = await import("./helpers/mqtt-session.ts");

/**
 * Run up to this many tests concurrently (env TEST_CONCURRENCY, default 8).
 * Measured at 4 000× speedup on a clean broker:
 *   C=1 ~268 s, C=4 ~69 s, C=8 ~37 s, C=12 ~35 s — all 20 tests pass.
 *   C=16 ~22 s but 7 tests fail: the shared broker's roundtrip latency pushes
 *   relay commands past their assertion windows.  8 keeps a safe margin below
 *   that cliff while giving most of the speedup.
 */
const TEST_CONCURRENCY = Math.max(1, parseInt(process.env.TEST_CONCURRENCY ?? "8", 10));

/** Consume the three relay commands that mark arrival at the 10:00 solar charge window. */
async function advanceToSolarWindow(relay: MqttRelaySimulator): Promise<void> {
  await relay.assertOn("2026-04-18T17:00"); // plug-in detection at session start
  await relay.assertOff("2026-04-18T17:10"); // sleep through the overnight gap
  await relay.assertOn("2026-04-19T10:00"); // solar-free slot begins charging
}

/**
 * Polls statusHistory() until the predicate matches one of the entries or
 * the timeout elapses.  Used to synchronise test assertions that depend on
 * async MQTT message delivery (e.g. waiting for the first watt reading).
 */
async function waitUntilStatus(
  statusHistory: () => readonly string[],
  predicate: (s: string) => boolean,
  timeoutMs = 3000,
): Promise<void> {
  const start = Date.now();
  while (!statusHistory().some(predicate)) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for status. History: ${JSON.stringify(statusHistory())}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

// Every session now uses its own MQTT topic prefix and plans directory, so the
// tests are safe to run concurrently.  Concurrency is controlled by the
// TEST_CONCURRENCY env var (default 1 = sequential).
describe("main-loop MQTT integration", { concurrency: TEST_CONCURRENCY }, () => {
  // ── mid-slot target-time change ──────────────────────────────────────────────
  //
  // These tests advance to the solar window, then call publishTargetTime() while
  // the 10:00 slot is actively running.  The change aborts the current plan and
  // replans with the new target.  The relay follows the new plan: it turns OFF
  // only when the current slot drops out of it (later-target test below) and
  // stays ON when the slot is still needed (status-clears test, which asserts
  // offCount==1).
  //
  // A single MQTT roundtrip advances virtual time by ~28 s at 4 000× speedup,
  // so the relay assertions below have comfortable margins.

  test("Changing target time earlier triggers replan and charges tonight instead of next day", async () => {
    const { loopPromise, relay, publishTargetTime, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // session start — plug-in detected

      // The first plan puts all charging at 10:00 next day, so the relay turns off
      // almost immediately and the loop goes to sleep for the overnight gap.
      await relay.assertOff("2026-04-18T17:30"); // off within half an hour of start

      // Change the deadline to 21:00 tonight while the loop is still in the
      // overnight sleep.  The replan callback fires, aborts the sleep, and the
      // loop picks evening slots starting at 17:00 (already past), so charging
      // restarts immediately.
      publishTargetTime("21:00");
      await relay.assertOnBefore("2026-04-19T00:00"); // back on the same evening

      await loopPromise;
    } finally {
      teardown();
    }
  });

  test("Mid-slot abort with later target: session replans and continues charging", async () => {
    // Initial target 08:00 → plan selects cheap overnight slots (around 01:00 AM).
    // By the time plan computation finishes (~17:31 virtual), the Apr 18 evening
    // slots in the plan are already past, so the first active slot is overnight.
    // Mid-slot we push the deadline out to 12:00, which replans to the solar-free
    // window at 10:00–11:45.  The relay must turn OFF after the abort (overnight
    // charging is no longer needed) and then back ON at the solar window.
    const { loopPromise, relay, publishTargetTime, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      { targetTime: "08:00" },
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection
      await relay.assertOff("2026-04-18T18:00"); // plan computed; sleeping until overnight slots
      await relay.assertOn("2026-04-19T01:00"); // first overnight cheap slot
      publishTargetTime("12:00"); // extend deadline mid-slot
      await relay.assertOff("2026-04-19T02:00"); // mid-slot abort before slot ends
      await relay.assertOn("2026-04-19T10:00"); // new plan: solar-free window
      await loopPromise;
    } finally {
      teardown();
    }
  });

  // Regression: a long-running session (started the previous evening) must
  // resolve a relative target-time override against the CURRENT time, not the
  // stale session-start time. Previously, anchoring on the start time placed
  // the new target in the past, the loop's "target passed" check fired, and
  // the session ended without charging. After reaching the next-day solar
  // window, setting an earlier HH:MM must roll to the following day and keep
  // charging — not end the session.
  test("Override after midnight resolves against current time, keeps charging", async () => {
    const { loopPromise, relay, publishTargetTime, sessionSummary, teardown } =
      await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay); // now ~10:00 on Apr 19, day after start
      // "09:30" is earlier than the current time of day. With a stale anchor it
      // would resolve to Apr 19 09:30 (already past) and end the session at
      // 0 kWh; with the fix it resolves to Apr 20 09:30 and charging continues.
      publishTargetTime("09:30");
      await loopPromise;
      const summary = sessionSummary();
      assert.ok(summary, "session must complete with a summary");
      assert.ok(summary!.chargedKwh >= 5, "session must keep charging, not end on stale target");
    } finally {
      teardown();
    }
  });

  // ── energy field ──────────────────────────────────────────────────────────────
  /**
   * Verifies that publisher.setChargedEnergy() is called with a positive value
   * while the relay is ON and the energyField is configured.
   *
   * Uses targetKwh=0.5 so only one slot is needed.  The relay simulator
   * publishes cumulative energy at 20 ms intervals; one 90 ms slot yields
   * 4 ticks at 20/40/60/80 ms, giving lastEnergy − startEnergy ≈ 0.667 kWh
   * (3 kW × 80 000 virtual ms / 3 600 000 > 0.5 kWh target).
   */
  test("Charged energy field is published during charging", async () => {
    const { loopPromise, relay, chargedEnergy, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      { targetKwh: 0.5 },
      { energyField: "energy" },
    );
    try {
      await advanceToSolarWindow(relay);
      await loopPromise; // single slot suffices: measured kWh > 0.5 kWh target
      // Poll briefly: the MQTT charged_energy publish is fire-and-forget so
      // the broker may not have delivered it to controlClient yet.
      const deadline = Date.now() + 500;
      while (chargedEnergy() === 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.ok(chargedEnergy() > 0, `Expected chargedEnergy > 0, got ${chargedEnergy()}`);
    } finally {
      teardown();
    }
  });

  /**
   * Full 7-slot solar session: verifies the final accumulated cost and solar
   * percentage logged after the session completes.
   *
   * All 7 slots at 10:00–11:45 on Apr 19 are solar-free (effectiveCostEur=0)
   * and the solar forecast exceeds the 3 kW charger power, so:
   *   accumulatedCost   === 0   (all slots free)
   *   accumulatedSolarPct === 100 (100% solar for every slot)
   */
  test("Session end: accumulated cost is 0 and solar% is 100 for all-solar session", async () => {
    const { loopPromise, relay, sessionSummary, teardown } = await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);
      await loopPromise;
      assert.equal(sessionSummary()?.solarPct, 100, "solar forecast exceeds charger power → 100%");
      assert.equal(sessionSummary()?.totalCostEur, 0, "all solar-free slots → zero cost");
      assert.equal(sessionSummary()?.plannedKwh, 5, "plannedKwh equals configured targetKwh");
    } finally {
      teardown();
    }
  });

  // ── status history ────────────────────────────────────────────────────────────
  /**
   * Verifies that the effective status sequence for a full 7-slot solar session
   * contains no flicker entries:
   *   - "Fetching data..." must never appear (removed from STATUS)
   *   - "Waiting for charging to start" must not appear after charging begins
   *   - "Planned charge start at …" must not appear after charging begins
   *
   * The expected clean sequence for FROM=17:00, targetTime=12:00, targetKwh=5:
   *   1. Waiting for car to be plugged in
   *   2. Planned charge start at 10:00   ← overnight gap, real wait
   *   3. Waiting for charging to start   ← relay ON, first watts not yet seen
   *   4. Charging until 12:00            ← all consecutive charge slots hold this status
   *   5. Idle                            ← target kWh reached
   */
  test("Status history is clean — no flicker between consecutive charge slots", async () => {
    const { loopPromise, relay, statusHistory, teardown } = await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);
      await loopPromise;
      // Baseline relay shape: ON (plug-in), OFF (gap), ON (solar window), then
      // stays ON — never toggles between consecutive charge slots.
      assert.equal(relay.offCount, 1, "relay must not toggle between consecutive charge slots");
      // "Idle" is published via MQTT after loopPromise resolves; wait for delivery.
      await waitUntilStatus(statusHistory, (s) => s === "Idle");

      const history = statusHistory();

      assert.ok(
        !history.includes("Fetching data..."),
        `"Fetching data..." must not appear in status history`,
      );

      const firstChargingIdx = history.findIndex((s) => s.startsWith("Charging until "));
      assert.ok(firstChargingIdx !== -1, 'Expected "Charging until …" status in history');

      const afterCharging = history.slice(firstChargingIdx + 1);
      const flicker = afterCharging.filter(
        (s) => s === "Waiting for charging to start" || s.startsWith("Planned charge start at "),
      );
      assert.deepEqual(
        flicker,
        [],
        `Flicker statuses after charging started: ${JSON.stringify(flicker)}\nFull history: ${JSON.stringify(history)}`,
      );

      assert.deepEqual(history, [
        "Starting...",
        "Waiting for car to be plugged in",
        "Planned charge start at 10:00",
        "Waiting for charging to start",
        "Charging until 12:00",
        "Idle",
      ]);
    } finally {
      teardown();
    }
  });

  /**
   * When the target time changes while a charge slot is actively running, the
   * status must transition away from "Charging until …" immediately — it must
   * not remain stuck on the old value until the next watt message arrives.
   * The replan bounds the charge run to the new deadline ("Charging until 10:45").
   * The current slot is still within the new window, so the relay keeps charging
   * and never turns OFF — the only OFF in the whole session is the overnight gap.
   */
  test("Status clears 'Charging until' immediately after mid-slot target-time change", async () => {
    const { loopPromise, relay, statusHistory, publishTargetTime, teardown } =
      await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);
      // Wait until the first watt message has pushed "Charging until …" into the history.
      await waitUntilStatus(statusHistory, (s) => s.startsWith("Charging until 12:00"));

      // Tighten the deadline while the 10:00 slot is running.  The current slot is
      // still within the new window, so the replan keeps the relay ON: status moves
      // straight to "Charging until 10:45" and the session charges through the
      // remaining slots without turning the relay OFF.
      publishTargetTime("10:45");

      await waitUntilStatus(statusHistory, (s) => s.startsWith("Charging until 10:45"));

      await loopPromise;
      assert.equal(
        relay.offCount,
        1,
        "tightening the deadline must not turn the relay OFF (current slot stays in the plan)",
      );
    } finally {
      teardown();
    }
  });

  // ── plan resume ───────────────────────────────────────────────────────────────
  /**
   * Verifies that chargedKwh persisted in a plan file is honoured on resume.
   *
   * Setup: pre-write a plan file with chargedKwh=3.75 (half of targetKwh=5).
   *
   * Expected relay commands when the session resumes at FROM=17:00 Apr 18:
   *   OFF — gap sleep until the first charge slot at 10:00 Apr 19
   *   ON  — first slot  (10:00–10:15, kwh += 0.75 → chargedKwh = 4.50)
   *   ON  — second slot (10:15–10:30, kwh += 0.75 → chargedKwh = 5.25 ≥ 5.0)
   *   OFF — target reached, session done
   *
   * Without the fix chargedKwh would be reset to 0 on resume, the planner
   * would schedule all 7 solar-free slots (10:00–11:45), the third assertOn
   * below would be followed by 4 more ONs, and the final assertOff would fail
   * because it would receive an ON instead.
   */
  test("Resumed session uses persisted chargedKwh — only remaining slots are charged", async () => {
    const planFile = {
      version: 1,
      createdAt: new Date("2026-04-18T14:00:00.000Z").toISOString(), // 17:00 Helsinki
      detectedPowerKw: 3,
      chargedKwh: 3.75,
      config: { targetKwh: 5, targetDateTime: "2026-04-19T12:00:00", powerKw: 3 },
      slots: [],
    };

    const { loopPromise, relay, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      { targetKwh: 5 },
      {},
      undefined,
      planFile,
    );
    try {
      // No plug-in detection ON — the session resumes directly without waitForStart().
      await relay.assertOff("2026-04-19T10:00"); // gap OFF before first charge slot
      await relay.assertOn("2026-04-19T10:00"); // first slot
      // Relay stays ON after target reached; no final OFF.
      await loopPromise;
    } finally {
      teardown();
    }
  });

  // ── no car power ──────────────────────────────────────────────────────────────
  /**
   * With no car power the state machine stays in WaitingForCar, which keeps the
   * relay ON and waits.  The loop must not error, resolve, or toggle the relay.
   *
   * Note: the loop never ends without a car — the target-time check re-resolves
   * the schedule against the current time, so at the nominal 12:00 deadline the
   * target rolls to the next day and the session keeps waiting.  This test
   * therefore bounds the observation window to the cached fixture dates
   * (2026-04-18/19/20) so no real network fetch can ever occur: the window
   * crosses the first target roll (12:00 on 2026-04-19, re-fetch served from
   * cache) but stays short of the 2026-04-21 fetch that would leave the cache.
   * abort() stops the loop deterministically so no zombie session is left
   * running (which would otherwise keep rolling targets and fetch the network).
   */
  test("No car power: relay stays ON and the loop waits without erroring", async () => {
    const { loopPromise, relay, abort, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      { plugInTimeoutMs: 60_000 },
      {},
      undefined,
      undefined,
      { suppressPower: true },
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // WaitingForCar holds the relay ON

      // The session must keep waiting (neither resolve nor reject).  At 4 000×
      // the 19 h to the nominal 12:00 target take ~17 s real; 22 s crosses the
      // roll into the cached 2026-04-19 day while staying short of 2026-04-21.
      const outcome = await Promise.race([
        loopPromise.then(
          () => "resolved",
          () => "rejected",
        ),
        new Promise<"waited">((resolve) => setTimeout(() => resolve("waited"), 22_000)),
      ]);
      assert.equal(outcome, "waited", "loop must keep waiting, not resolve or reject");
      assert.equal(relay.offCount, 0, "relay must never turn OFF while waiting for a car");
    } finally {
      // Stop the never-ending session cleanly, then close the MQTT clients.
      abort();
      await loopPromise;
      teardown();
    }
  });

  // ── heating hold ──────────────────────────────────────────────────────────────
  /**
   * All tests use FROM=17:00 (same as the baseline scenario) so planning
   * overhead never skips the gap sleep.  The holdWhenHeating config uses a
   * dedicated test topic that is separate from the charger power topic.
   * Threshold 2000 W: >2000 W → relay held OFF; ≤2000 W → relay may be ON.
   *
   * Virtual slot 10:00–10:15 = 225 ms real at 4 000×.
   * Virtual gap 17:00→10:00 = 17 h = ~15.3 s real.
   *
   * Synchronisation: publishHeatingPower() is safe to call once startMqttSession()
   * returns because the heating subscription SUBACK always precedes relay.ready
   * (the heating subscribe is issued earlier in the same connection sequence).
   */
  const HEATING = {
    holdWhenHeating: {
      mqtt: { powerTopic: "evchargeboss-test/heating", powerField: "power" },
    },
  };

  /**
   * Charging is running normally when heating suddenly exceeds the threshold.
   * The relay must turn OFF immediately without waiting for the slot to end,
   * then back ON when heating clears.
   *
   * Expected relay sequence:
   *   ON  (17:00) — plug-in
   *   OFF (10:00) — gap
   *   ON  (10:00) — slot starts, no hold
   *   OFF (< 10:15) — hold fires
   *   ON  (< 10:15) — hold releases
   */
  test("Hold fires mid-charge: relay turns OFF then back ON within the same slot", async () => {
    const { loopPromise, relay, publishHeatingPower, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      HEATING,
      {},
      undefined,
      undefined,
      { holdThreshold: 2000 },
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in
      await relay.assertOff("2026-04-19T10:00"); // gap
      await relay.assertOn("2026-04-19T10:00"); // charging starts, no hold
      publishHeatingPower(3000); // trigger hold mid-charge
      await relay.assertOff("2026-04-19T10:15"); // hold-triggered OFF within the slot
      publishHeatingPower(0); // release hold
      await relay.assertOnBefore("2026-04-19T10:15"); // relay ON again within the slot
      await loopPromise;
    } finally {
      teardown();
    }
  });

  /**
   * Heating fires and clears entirely during the overnight gap (relay already
   * OFF, no holdHandle active).  This must produce zero extra relay commands.
   *
   * Expected relay sequence (identical to baseline):
   *   ON  (17:00) — plug-in
   *   OFF (17:xx) — gap sleep
   *   ON  (10:00) — slot starts normally (heating already off)
   * Total OFFs: 2 (gap + session end only).
   */
  test("Heating during gap does not cause spurious relay commands", async () => {
    const { loopPromise, relay, publishHeatingPower, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      HEATING,
      {},
      undefined,
      undefined,
      { holdThreshold: 2000 },
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in
      await relay.assertOff("2026-04-19T10:00"); // gap sleep starts (~15.3 s real)
      // Publish heating during the gap then release it 3 s later (mid-gap).
      // The slot does not start for another ~12 s so heating is off well before then.
      publishHeatingPower(3000);
      setTimeout(() => publishHeatingPower(0), 3000);
      await relay.assertOn("2026-04-19T10:00"); // normal slot start — no hold
      // Exactly 1 OFF so far (the gap). If heating had caused a spurious relay OFF
      // between the gap and the slot start, assertOn above would have consumed it
      // and failed. Checking offCount==1 here confirms no extra OFFs were sent.
      assert.equal(relay.offCount, 1, "heating during gap must not emit spurious relay OFFs");
      await loopPromise;
    } finally {
      teardown();
    }
  });

  /**
   * Verifies the full hold lifecycle for a hold already active when the 10:00
   * charge slot starts: the relay is held OFF through the slot start, turns ON
   * when heating releases, and the MQTT status reflects each phase.
   *
   * Expected relay sequence:
   *   ON  (17:00) — plug-in detection
   *   OFF (17:xx) — gap sleep until 10:00
   *   [no ON at 10:00 — heating hold blocks the relay]
   *   ON  (< 10:15) — relay turns ON when heating releases
   *
   * Expected status (partial):
   *   …  Planned charge start at 10:00
   *   →  Charging paused (heating)        — when slot starts with hold active
   *   →  Waiting for charging to start    — when heating releases and relay goes ON
   *      (or "Charging until …" if watts arrive before status check)
   */
  test("Status shows heatingHold then charging-active status after hold releases", async () => {
    const { loopPromise, relay, publishHeatingPower, statusHistory, teardown } =
      await startMqttSession(FROM, SPEEDUP, HEATING, {}, undefined, undefined, {
        holdThreshold: 2000,
      });
    try {
      publishHeatingPower(3000);
      await relay.assertOn("2026-04-18T17:00");
      await relay.assertOff("2026-04-19T10:00");
      await waitUntilStatus(statusHistory, (s) => s === "Charging paused (heating)", 30_000);
      publishHeatingPower(0);
      await relay.assertOnBefore("2026-04-19T10:15");
      await waitUntilStatus(
        statusHistory,
        (s) => s === "Waiting for charging to start" || s.startsWith("Charging until "),
      );
      await loopPromise;

      const history = statusHistory();
      const holdIdx = history.indexOf("Charging paused (heating)");
      assert.ok(
        holdIdx !== -1,
        `Expected "Charging paused (heating)" in status history. Got: ${JSON.stringify(history)}`,
      );
      const afterHold = history.slice(holdIdx + 1);
      assert.ok(
        afterHold.some(
          (s) => s === "Waiting for charging to start" || s.startsWith("Charging until "),
        ),
        `Expected charging status after hold releases. History after hold: ${JSON.stringify(afterHold)}`,
      );
    } finally {
      teardown();
    }
  });

  // ── Charge Now ────────────────────────────────────────────────────────────────
  /**
   * Regression test for the past-slot relay-flicker bug.
   *
   * Scenario: user presses Charge Now at 17:00 → target set to 19:00.
   * The planner selects 7 cheapest slots from the 8-slot 17:00–19:00 window:
   *   17:00(1.17c), 17:15(2.96c), 17:30(4.76c), 17:45(6.65c),
   *   18:00(4.98c), 18:15(5.97c), 18:30(7.45c)  — 18:45(8.51c) is skipped.
   *
   * Bug: at the 17:45 slot boundary, slotsNeeded drops to 4.  With the bug,
   * the pool still contains past slots 17:00/17:15/17:30 (the three cheapest),
   * which occupy 3 of the 4 seats → only 18:00 is selected as the 4th future
   * slot → 17:45 (the CURRENT charging slot) gets charge=false → relay OFF.
   *
   * Fix: past slots are excluded from computePlan before sorting, so only
   * 5 future slots compete for 4 seats.  17:45 remains selected and the relay
   * stays ON throughout all 7 consecutive charge slots.
   *
   * Expected relay sequence (no flicker):
   *   ON  (17:00) — WaitingForCar plug-in detection
   *   OFF (17:xx) — Planning (while initial 12:00 plan is computed)
   *   [Charge Now published → replan to 19:00]
   *   ON  (≤18:00) — first charge slot begins
   *   (relay stays ON after charging completes — no final OFF)
   * Total OFFs: 1 (no slot-boundary flicker)
   */
  test("Charge Now: relay stays ON through all slot boundaries (no past-slot flicker)", async () => {
    const { loopPromise, relay, publishTargetTime, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      { targetKwh: 5 },
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection
      await relay.assertOff("2026-04-18T17:10"); // enters overnight-gap sleep

      // Simulate "Charge Now": override target to 2 hours from session start.
      publishTargetTime("19:00");

      // Charging must start in the near future (evening priced slots).
      await relay.assertOnBefore("2026-04-18T18:00");

      // Session completes when chargedKwh reaches targetKwh; relay stays ON
      // (no final OFF — battery-full detection waits for power to drop).
      await loopPromise;

      // offCount must be exactly 1:
      //   1. Planning state at session start (overnight-gap sleep)
      // With the bug, relay flickered OFF/ON at the 17:45 boundary (and later
      // boundaries), so offCount would be ≥ 2.
      assert.equal(
        relay.offCount,
        1,
        "relay must not flicker at slot boundaries during Charge Now",
      );
    } finally {
      teardown();
    }
  });

  // ── detected charger power ────────────────────────────────────────────────────
  /**
   * Verifies that the planner uses live-measured charger power when it exceeds
   * the configured value, not just the config default.
   *
   * Setup: configure powerKw=2 but the relay simulator always emits 3000 W.
   *   Detection condition: currentPowerW / 1000 = 3 > 2 → detectedChargerPowerKw updates to 3.
   *
   * With detected 3 kW:  slotsNeeded = ceil(0.75 / (3 × 0.25)) = 1 slot.
   * Without detection:   slotsNeeded = ceil(0.75 / (2 × 0.25)) = 2 slots.
   *
   * Per-slot kWh accounting uses detectedChargerPowerKw × 0.25 (no energyField),
   * so chargedKwh after the first slot = detectedChargerPowerKw × 0.25:
   *   3 kW → 0.75 kWh (target reached; session ends after 1 slot)
   *   2 kW → 0.50 kWh (target not reached; a second slot runs; chargedKwh = 1.0)
   */
  test("Plan and slot accounting use detected power, not configured powerKw", async () => {
    const { loopPromise, relay, sessionSummary, teardown } = await startMqttSession(FROM, SPEEDUP, {
      powerKw: 2,
      targetKwh: 0.75,
    });
    try {
      await advanceToSolarWindow(relay);
      await loopPromise;
      // With detection: chargedKwh = 3 kW × 0.25 h = 0.75 (target hit, done in 1 slot).
      // Without detection: chargedKwh = 2 kW × 0.25 h × 2 slots = 1.0 (overcharged).
      assert.equal(
        sessionSummary()?.chargedKwh,
        0.75,
        "session must end after 1 slot using detected 3 kW, not configured 2 kW",
      );
      assert.equal(sessionSummary()?.plannedKwh, 0.75, "plannedKwh equals overridden targetKwh");
    } finally {
      teardown();
    }
  });

  // ── target time reset ─────────────────────────────────────────────────────────
  /**
   * After a Charge Now session completes, resetTargetTime() must publish the
   * schedule-aware default time (e.g. "12:00") to the target_time/state topic,
   * overwriting the stale Charge Now override (e.g. "19:00").
   *
   * Regression: previously resetTargetTime() published an empty string, which
   * Home Assistant ignores, leaving the stale "19:00" retained on the broker.
   */
  test("Charge Now: target_time/state reset to config default after session ends", async () => {
    const { loopPromise, relay, publishTargetTime, targetTimeState, teardown } =
      await startMqttSession(FROM, SPEEDUP, { targetKwh: 5 });
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection
      await relay.assertOff("2026-04-18T17:10"); // enters overnight-gap sleep

      // Simulate Charge Now: charge for a 2-hour window this evening.
      publishTargetTime("19:00");

      await loopPromise;

      // Wait up to 500 ms for the retained publish to reach the control client.
      const deadline = Date.now() + 500;
      while (targetTimeState() !== "12:00" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }

      assert.equal(
        targetTimeState(),
        "12:00",
        "target_time/state must be reset to config default after Charge Now session ends",
      );
    } finally {
      teardown();
    }
  });

  // ── target kWh override ───────────────────────────────────────────────────────
  /**
   * Verifies that publishing a kWh override via MQTT replaces the configured
   * target and is reset to the config default after the session ends.
   *
   * Scenario:
   *   - Config targetKwh=5 (needs 7 slots at 3 kW).
   *   - After charging starts at 10:00, publish targetKwh=0.75 (1 slot).
   *   - Coordinator wakes, rebuilds plan with new target, session ends after
   *     1 slot instead of 7.
   *   - After session end, target_kwh/state must be reset to "5" (config value).
   */
  test("targetKwh override: session ends early when kWh target reduced mid-session", async () => {
    const { loopPromise, relay, publishTargetKwh, targetKwhState, teardown } =
      await startMqttSession(FROM, SPEEDUP);
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection
      await relay.assertOff("2026-04-18T17:10"); // sleep through overnight gap
      await relay.assertOn("2026-04-19T10:00"); // first charge slot starts

      // Reduce target to 0.75 kWh (1 slot) while charging is underway.
      publishTargetKwh(0.75);

      // Session must complete (target reached after 1 slot instead of 7).
      await loopPromise;

      // After session end, target_kwh/state must be reset to the config default.
      const deadline = Date.now() + 500;
      while (targetKwhState() !== 5 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(
        targetKwhState(),
        5,
        "target_kwh/state must be reset to config default (5) after session ends",
      );
    } finally {
      teardown();
    }
  });

  // ── charge level re-plan ──────────────────────────────────────────────────────
  /**
   * When charge level (battery SoC %) changes and chargedKwh is still 0
   * (charging hasn't started), a re-plan is triggered. The adjusted target
   * is targetKwh * (100 - chargeLevelPct) / 100.
   *
   * When chargedKwh > 0 (charging has started), charge level changes do NOT
   * trigger a re-plan, since internal tracking is more accurate.
   *
   * Tests use a unique chargeLevelTopic per session to prevent interference.
   */

  test("Charge level change triggers re-plan when chargedKwh=0", async () => {
    // Use a unique charge level topic for this test session.
    const chargeLevelTopic = `evchargeboss-test/charge-level-${process.pid}-${Date.now()}`;
    const { loopPromise, relay, publishChargeLevel, sessionSummary, teardown } =
      await startMqttSession(
        FROM,
        SPEEDUP,
        { targetKwh: 10 }, // higher target so charge level reduction is meaningful
        { chargeLevelTopic },
      );
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection

      // Publish initial charge level (50%) - this establishes the baseline.
      publishChargeLevel(50);

      // Wait a moment for the message to be processed, then change charge level.
      await new Promise((r) => setTimeout(r, 50));

      // The first plan puts charging at 10:00 next day, so relay turns off.
      await relay.assertOff("2026-04-18T17:30");

      // Publish a different charge level (70%) while sleeping in the overnight gap.
      // Since chargedKwh is still 0, this should trigger a re-plan.
      publishChargeLevel(70);

      // The re-plan applies the adjusted target: 10 kWh × (100 − 70)% = 3 kWh.
      // The plan honours it (plannedKwh === 3) while actual charging continues to
      // the raw 10 kWh target via solar-free slots — the car BMS bounds it in
      // production, and the relay simulator draws power indefinitely.
      await loopPromise;

      assert.equal(sessionSummary()?.plannedKwh, 3, "plannedKwh equals the adjusted target");
      assert.equal(relay.offCount, 1, "relay must not disconnect spuriously");
    } finally {
      teardown();
    }
  });
  test("Charge level change does NOT trigger re-plan when chargedKwh>0", async () => {
    // This test verifies that once charging has started (chargedKwh > 0),
    // charge level changes do NOT trigger a re-plan.
    const chargeLevelTopic = `evchargeboss-test/charge-level-${process.pid}-${Date.now()}`;
    const { loopPromise, relay, publishChargeLevel, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      { targetKwh: 5 },
      { chargeLevelTopic },
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection

      // Publish initial charge level.
      publishChargeLevel(20);
      await new Promise((r) => setTimeout(r, 50));

      await relay.assertOff("2026-04-18T17:30"); // enters overnight-gap sleep

      // Wait for charging to start at 10:00.

      await relay.assertOn("2026-04-19T10:00");

      // Now chargedKwh > 0. Publish a different charge level.
      // This should NOT trigger a re-plan.
      publishChargeLevel(80);

      // Session completes normally - the charge level change was ignored.
      await loopPromise;

      // If we got here without errors, the test passed.
      // The relay should have only turned off once (during the overnight gap).
      assert.equal(relay.offCount, 1, "relay should only have turned off once (overnight gap)");
    } finally {
      teardown();
    }
  });

  // ── weekly charging schedule ──────────────────────────────────────────────────
  /**
   * FROM = Saturday 2026-04-18T17:00.  The default targetTime="12:00" puts all
   * charging at 10:00 next day (relay: ON 17:00 -> OFF 17:10 -> ON 10:00).
   * Setting the Saturday schedule to 21:00 makes the deadline this evening, so
   * the loop replans and charging restarts immediately.
   */
  test("Schedule set via MQTT updates state topic, runtime plan, and config write-back", async () => {
    // Temp copy of the config so write-back never touches the shared fixture.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "evcb-schedule-"));
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(configPath, JSON.stringify(loadConfig(), null, 2) + "\n", "utf8");

    const { loopPromise, relay, publishScheduleTime, scheduleState, teardown } =
      await startMqttSession(FROM, SPEEDUP, {}, {}, undefined, undefined, { configPath });
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection
      await relay.assertOff("2026-04-18T17:10"); // overnight-gap sleep (default 12:00 target)

      // Saturday 21:00 becomes the new deadline while the loop sleeps -> replan.
      publishScheduleTime("sat", "21:00");
      await relay.assertOnBefore("2026-04-19T00:00"); // back on the same evening

      // The new value is published to schedule/sat/state.
      const deadline = Date.now() + 500;
      while (scheduleState("sat") !== "21:00" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(scheduleState("sat"), "21:00", "schedule/sat/state must reflect the edit");

      // And persisted to the on-disk config file.
      const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
        evCharging: { weeklySchedule: Record<string, string> };
      };
      assert.equal(raw.evCharging.weeklySchedule.sat, "21:00");

      await loopPromise;
    } finally {
      teardown();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test("Retained schedule state is recovered at startup and used for planning", async () => {
    const { loopPromise, relay, scheduleState, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      {},
      {},
      undefined,
      undefined,
      { initialScheduleState: { sat: "21:00" } },
    );
    try {
      // The recovered value is published back to schedule/sat/state.
      const deadline = Date.now() + 3000;
      while (scheduleState("sat") !== "21:00" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.equal(scheduleState("sat"), "21:00", "schedule/sat/state must reflect recovery");

      // Deadline is 21:00 tonight instead of 12:00 next day.  Charging starts
      // this evening: the relay toggles between non-adjacent slots, then turns
      // back ON the same evening.  (With the default 12:00 target it would stay
      // OFF for the overnight gap and only come back at 10:00 next day.)
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection
      await relay.assertOff("2026-04-18T22:00"); // gap between this-evening slots
      await relay.assertOnBefore("2026-04-19T00:00"); // charging resumes tonight

      await loopPromise;
    } finally {
      teardown();
    }
  });
}); // describe "main-loop MQTT integration"
