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
      await loopPromise; // 7 × 15-min slots complete (~630 ms real), loop exits via justOnce
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
