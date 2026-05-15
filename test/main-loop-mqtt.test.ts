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
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { MqttRelaySimulator } from "./helpers/mqtt-relay-simulator.ts";

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

const { FROM, SPEEDUP } = await import("./helpers/config.ts");
const { startMqttSession } = await import("./helpers/mqtt-session.ts");

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

// Tests run sequentially: each MQTT session subscribes to the same topics, so
// concurrent execution would cause relay simulators to receive each other's commands.
describe("main-loop MQTT integration", { concurrency: false }, () => {
  test("Relay sees ON → OFF → ON during a single charge session", async () => {
    const { loopPromise, relay, teardown } = await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);
      // Slots 2–7 are consecutive ON (10:15–11:45).

      // Relay stays ON after charging completes (battery-full detection).
      await loopPromise;
      assert.equal(relay.offCount, 1, "relay must not toggle between consecutive charge slots");
    } finally {
      teardown();
    }
  });

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

  // ── mid-slot abort tests ─────────────────────────────────────────────────────
  //
  // Both tests advance to the solar window, then call publishTargetTime() while
  // the 10:00 slot is actively running.  The slot is aborted (relay sees OFF
  // before the natural 10:15 end) and the session replans with the new target.
  //
  // A single MQTT roundtrip advances virtual time by ~70 s at 10 000× speedup,
  // so assertOff("10:15") provides a comfortable 14-minute margin.

  test("Mid-slot abort with earlier target: session replans and keeps charging", async () => {
    const { loopPromise, relay, publishTargetTime, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
    );
    try {
      await advanceToSolarWindow(relay);
      publishTargetTime("10:45"); // tighten deadline while the 10:00 slot is running
      await relay.assertOff("2026-04-19T10:48"); // slot aborted before natural end
      await loopPromise;
    } finally {
      teardown();
    }
  });

  test("Mid-slot abort with later target: session replans and continues charging", async () => {
    const { loopPromise, relay, publishTargetTime, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
    );
    try {
      await advanceToSolarWindow(relay);
      publishTargetTime("14:00"); // extend deadline while the 10:00 slot is running
      await relay.assertOff("2026-04-19T14:00");
      await loopPromise;
    } finally {
      teardown();
    }
  });
}); // describe "main-loop MQTT integration"

describe("main-loop MQTT integration — energy field", { concurrency: false }, () => {
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
    } finally {
      teardown();
    }
  });
});

describe("main-loop MQTT integration — status history", { concurrency: false }, () => {
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
   *   4. Charging until 11:45            ← all 7 consecutive slots hold this status
   *   5. Idle                            ← target kWh reached
   */
  test("Status history is clean — no flicker between consecutive charge slots", async () => {
    const { loopPromise, relay, statusHistory, teardown } = await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);
      await loopPromise;
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
   * slot is aborted and the relay is turned off.  The status must transition
   * away from "Charging until …" immediately — it must not remain stuck on the
   * old value until the next watt message arrives on the restarted relay.
   *
   * Expected sequence (target changed to 10:45 while the 10:00 slot is running):
   *   1. Waiting for car to be plugged in
   *   2. Planned charge start at 10:00
   *   3. Waiting for charging to start
   *   4. Charging until 12:00      ← from the initial 8-slot plan
   *   5. Re-planning...            ← set immediately when target changes (the fix)
   *   6. Waiting for charging to start  ← re-run of the aborted slot
   *   7. Charging until 10:45      ← new 3-slot plan with chargeRunEnd=10:45
   *   … (session continues with new target)
   */
  test("Status clears 'Charging until' immediately after mid-slot target-time change", async () => {
    const { loopPromise, relay, statusHistory, publishTargetTime, teardown } =
      await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);
      // Wait until the first watt message has pushed "Charging until …" into the history.
      await waitUntilStatus(statusHistory, (s) => s.startsWith("Charging until 12:00"));

      // Abort the active slot by changing the target time.
      publishTargetTime("10:45");

      await waitUntilStatus(statusHistory, (s) => s.startsWith("Charging until 10:45"));

      await loopPromise;
    } finally {
      teardown();
    }
  });
}); // describe "main-loop MQTT integration — status history"

describe("main-loop MQTT integration — plan resume", { concurrency: false }, () => {
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
}); // describe "main-loop MQTT integration — plan resume"

describe("main-loop MQTT integration — plug-in timeout", { concurrency: false }, () => {
  test("It just waits and if no car power is detected, not erroring. Exists on target time reached.", async () => {
    const { loopPromise, relay, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      { plugInTimeoutMs: 60_000 }, // 60 s virtual → 6 ms real
      {},
      undefined,
      undefined,
      { suppressPower: true },
    );
    try {
      // Observe both the relay command and the loop rejection in parallel.
      // This avoids the unhandledRejection race where loopPromise rejects
      // (after the 6 ms real timeout) before assert.rejects() is set up —
      // which would fail the test even though the rejection is the expected one.
      const [relayResult, loopResult] = await Promise.allSettled([
        relay.assertOn("2026-04-18T17:00"), // waitForStart sends ON before waiting
        loopPromise,
      ]);
      assert.equal(relayResult.status, "fulfilled", "Expected relay ON during plug-in detection");
      assert.equal(loopResult.status, "fulfilled", "Expected loopPromise to resolve on timeout");
    } finally {
      teardown();
    }
  });
}); // describe "main-loop MQTT integration — plug-in timeout"

describe("main-loop MQTT integration — heating hold", { concurrency: false }, () => {
  /**
   * All tests use FROM=17:00 (same as the baseline scenario) so planning
   * overhead never skips the gap sleep.  The holdWhenHeating config uses a
   * dedicated test topic that is separate from the charger power topic.
   * Threshold 2000 W: >2000 W → relay held OFF; ≤2000 W → relay may be ON.
   *
   * Virtual slot 10:00–10:15 = 90 ms real at 10 000×.
   * Virtual gap 17:00→10:00 = 17 h = ~6.1 s real.
   *
   * Synchronisation: publishHeatingPower() is safe to call once startMqttSession()
   * returns because the heating subscription SUBACK always precedes relay.ready
   * (the heating subscribe is issued earlier in the same connection sequence).
   */
  const HEATING = {
    holdWhenHeating: {
      thresholdW: 2000,
      mqtt: { powerTopic: "evchargeboss-test/heating", powerField: "power" },
    },
  };

  /**
   * Heating is published ON immediately after the session starts, which is
   * guaranteed to be delivered before the 10:00 charge slot (the gap is ~6 s real).
   *
   * Expected relay sequence:
   *   ON  (17:00) — plug-in detection
   *   OFF (17:xx) — gap sleep until 10:00
   *   [no ON at 10:00 — heating hold blocks the relay]
   *   ON  (< 10:15) — relay turns ON when heating releases
   */
  test("Hold active when slot starts: relay stays OFF until heating releases", async () => {
    const { loopPromise, relay, publishHeatingPower, statusHistory, teardown } =
      await startMqttSession(FROM, SPEEDUP, HEATING);
    try {
      // Publish heating immediately — subscription SUBACK already received, so
      // delivery is guaranteed before the 10:00 slot starts (~6.1 s later).
      publishHeatingPower(3000);
      await relay.assertOn("2026-04-18T17:00"); // plug-in detection
      await relay.assertOff("2026-04-19T10:00"); // gap sleep (17 h virtual)
      // Wait for heatingHold status — confirms slot started with hold active.
      // 10 s timeout covers the ~6.1 s gap plus MQTT roundtrip.
      await waitUntilStatus(statusHistory, (s) => s === "Charging paused (heating peak)", 10_000);
      publishHeatingPower(0); // release heating — relay must turn ON within the slot
      await relay.assertOnBefore("2026-04-19T10:15");
      await loopPromise;
    } finally {
      teardown();
    }
  });

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
    );
    try {
      await relay.assertOn("2026-04-18T17:00"); // plug-in
      await relay.assertOff("2026-04-19T10:00"); // gap sleep starts (~6.1 s real)
      // Publish heating during the gap then release it 3 s later (mid-gap).
      // The slot does not start for another ~6 s so heating is off well before then.
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
   * Verifies the MQTT status sequence reflects the hold lifecycle.
   * Same scenario as the first test; asserts status messages instead of
   * (only) relay commands.
   *
   * Expected status (partial):
   *   …  Planned charge start at 10:00
   *   →  Charging paused (heating peak)   — when slot starts with hold active
   *   →  Waiting for charging to start    — when heating releases and relay goes ON
   *      (or "Charging until …" if watts arrive before status check)
   */
  test("Status shows heatingHold then charging-active status after hold releases", async () => {
    const { loopPromise, relay, publishHeatingPower, statusHistory, teardown } =
      await startMqttSession(FROM, SPEEDUP, HEATING);
    try {
      publishHeatingPower(3000);
      await relay.assertOn("2026-04-18T17:00");
      await relay.assertOff("2026-04-19T10:00");
      await waitUntilStatus(statusHistory, (s) => s === "Charging paused (heating peak)", 10_000);
      publishHeatingPower(0);
      await relay.assertOnBefore("2026-04-19T10:15");
      await waitUntilStatus(
        statusHistory,
        (s) => s === "Waiting for charging to start" || s.startsWith("Charging until "),
      );
      await loopPromise;

      const history = statusHistory();
      const holdIdx = history.indexOf("Charging paused (heating peak)");
      assert.ok(
        holdIdx !== -1,
        `Expected "Charging paused (heating peak)" in status history. Got: ${JSON.stringify(history)}`,
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
}); // describe "main-loop MQTT integration — heating hold"

describe("main-loop MQTT integration — Charge Now", { concurrency: false }, () => {
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
}); // describe "main-loop MQTT integration — Charge Now"

describe("main-loop MQTT integration — detected charger power", { concurrency: false }, () => {
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
    } finally {
      teardown();
    }
  });
}); // describe "main-loop MQTT integration — detected charger power"
