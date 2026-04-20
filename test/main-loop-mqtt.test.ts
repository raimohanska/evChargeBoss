/**
 * Integration test: main loop drives a real MQTT broker.
 *
 * Requires a Mosquitto broker on localhost:1883.
 * Start one with: docker compose up -d
 *
 * Scenario
 * --------
 * from = 2026-04-18T17:00, targetTime = "12:00" (next day), targetKwh = 5 (7 slots).
 * All 7 slots fall in the solar window 10:00–11:45 next day (solar-free, 0 €).
 * Because the charge slot is far in the future, runCharging sends:
 *
 *   ON  ← waitForStart() announces the charger is ready and waits for plug-in
 *   OFF ← runCharging sleeps through the 17:00–10:00 gap with charger off
 *   ON  ← 10:00 (next day) charge slot starts
 *
 * The MqttRelaySimulator sits on the charger topic, records every command, and
 * starts emitting power readings when it sees ON so waitForPlugIn resolves.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { parseTargetTime } from "../src/main-loop.ts";
import { plan } from "../src/planner.ts";
import { FROM, SPEEDUP, makeTestConfig } from "./helpers/config.ts";
import { startMqttSession } from "./helpers/mqtt-session.ts";

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

test("Plan for the 17:00 session: 7 solar-free charge slots 10:00–11:45 next day", async () => {
  const config = makeTestConfig();
  const targetDate = parseTargetTime(config.charging.targetTime, FROM);
  const slots = await plan(FROM, targetDate, config.charging.targetKwh, config);

  const chargeSlots = slots.filter(s => s.charge);
  assert.equal(chargeSlots.length, 7, "7 charge slots for 5 kWh at 3 kW");

  const first = chargeSlots[0];
  const last = chargeSlots[chargeSlots.length - 1];
  assert.equal(first.start.toISOString().slice(0, 10), "2026-04-19", "charge slots are next day");
  assert.equal(first.start.getHours(), 10, "first slot starts at 10:00");
  assert.equal(first.start.getMinutes(), 0, "first slot starts on the hour");
  assert.equal(last.end.getHours(), 11, "last slot ends at 11:45");
  assert.equal(last.end.getMinutes(), 45, "last slot ends at 11:45");
  assert.ok(chargeSlots.every(s => s.effectiveCostEur === 0), "all slots solar-free: zero cost");
});

test("Main loop with MQTT. Relay sees ON → OFF → ON during a single charge session", async () => {
  const { loopPromise, relay, teardown } = await startMqttSession(FROM, SPEEDUP);
  try {
    await relay.assertOn("2026-04-18T17:00");   // waitForStart() fires immediately at session start
    await relay.assertOff("2026-04-19T10:00");  // gap: charger off until the charge window
    await relay.assertOn("2026-04-19T10:00");   // first charge slot begins
    await loopPromise; // 7 × 15-min slots complete (~630 ms real), loop exits via justOnce
  } finally {
    teardown();
  }
});
