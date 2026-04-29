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
 *
 * advanceToSolarWindow() encodes this common three-step prelude used by most
 * tests.  Tests that trigger a replan during the sleep skip the third step.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { MqttRelaySimulator } from "./helpers/mqtt-relay-simulator.ts";
import { FROM, SPEEDUP } from "./helpers/config.ts";
import { startMqttSession } from "./helpers/mqtt-session.ts";

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

/** Consume the three relay commands that mark arrival at the 10:00 solar charge window. */
async function advanceToSolarWindow(relay: MqttRelaySimulator): Promise<void> {
  await relay.assertOn("2026-04-18T17:00"); // plug-in detection at session start
  await relay.assertOff("2026-04-19T10:00"); // sleep through the overnight gap
  await relay.assertOn("2026-04-19T10:00"); // solar-free slot begins charging
}

// Tests run sequentially: each MQTT session subscribes to the same topics, so
// concurrent execution would cause relay simulators to receive each other's commands.
describe("main-loop MQTT integration", { concurrency: false }, () => {
  test("Relay sees ON → OFF → ON during a single charge session", async () => {
    const { loopPromise, relay, teardown } = await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);

      // Slots 2–7 are consecutive (10:15–11:45). Each re-plan sends driver.send(true)
      // again, but there must be NO OFF between them.  assertOnBefore() fails
      // immediately if it sees an OFF instead — that is the key assertion here.
      for (let i = 0; i < 6; i++) {
        await relay.assertOnBefore("2026-04-19T11:46"); // all slots start before window end
      }

      // Final OFF is sent when the target kWh is reached.  Waiting for it
      // explicitly avoids a race where loopPromise resolves (PUBACK) before the
      // relay client's message handler fires.
      await relay.assertOff("2026-04-19T12:00");
      assert.equal(relay.offCount, 2, "relay must not toggle between consecutive charge slots");

      await loopPromise;
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

  test("Mid-slot abort with earlier target: session replans and charges again immediately", async () => {
    const { loopPromise, relay, publishTargetTime, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
    );
    try {
      await advanceToSolarWindow(relay);
      publishTargetTime("10:45"); // tighten deadline while the 10:00 slot is running
      await relay.assertOff("2026-04-19T10:15"); // slot aborted before natural end
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
      await relay.assertOff("2026-04-19T10:15"); // slot aborted before natural end
      // After replanning with the extended deadline the loop picks new slots and
      // immediately resumes charging — relay turns back ON within the same window.
      await relay.assertOnBefore("2026-04-19T10:30");
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
    const { loopPromise, relay, accumulatedCost, accumulatedSolarPct, teardown } =
      await startMqttSession(FROM, SPEEDUP);
    try {
      await advanceToSolarWindow(relay);
      await loopPromise;
      assert.equal(accumulatedCost(), 0, "all solar-free slots → zero cost");
      assert.equal(accumulatedSolarPct(), 100, "solar forecast exceeds charger power → 100%");
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
});
