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
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { connectMqtt, makeMqttSession } from "../src/mqtt-client.ts";
import { createPublisher } from "../src/mqtt-status.ts";
import { makeClock } from "../src/utils.ts";
import { runMainLoop, parseTargetTime } from "../src/main-loop.ts";
import { IncompleteDataError } from "../src/errors.ts";
import { STATUS } from "../src/mqtt-status.ts";
import { plan } from "../src/planner.ts";
import { MqttRelaySimulator } from "./mqtt-relay-simulator.ts";
import { assertAt, assertBefore } from "./test-helpers.ts";



const FROM = new Date("2026-04-18T17:00:00");
const SPEEDUP = 10_000;

function makeTestConfig(): Config {
  const base = loadConfig();
  return {
    ...base,
    mode: "charge" as const,
    mqtt: { ...base.mqtt!, brokerUrl: "mqtt://localhost:1883" },
    charging: { ...base.charging, targetKwh: 5 },
    test: { timeSpeedupFactor: SPEEDUP, justOnce: true },
  };
}

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

function errorStatus(err: unknown): string {
  if (err instanceof IncompleteDataError) return STATUS.waitingForSpot;
  return STATUS.error(err instanceof Error ? err.message : String(err));
}

test("Main loop with MQTT. Relay sees ON → OFF → ON during a single charge session", async () => {
  const config = makeTestConfig();

  // Two independent connections: one for the system loop, one for the relay simulator.
  const [sessionClient, relayClient] = await Promise.all([
    connectMqtt(config.mqtt!),
    connectMqtt(config.mqtt!),
  ]);

  // LoggingPublisher (no MQTT client) — publisher is only used for status logs here.
  const publisher = createPublisher(config);
  const session = makeMqttSession(sessionClient, config.mqtt!, publisher);
  const clock = makeClock(SPEEDUP, FROM);
  const relay = new MqttRelaySimulator(relayClient, config.mqtt!, clock);

  try {
    const loopPromise = runMainLoop(session, publisher, config, FROM, errorStatus, clock);

    // waitForStart() sends ON then waits for power readings from the relay simulator.
    const t0 = await relay.assertNextState(true);
    assertAt(t0, "2026-04-18T17:00", "First ON (session start)");

    // runCharging sees a 17-hour gap before the 10:00 next-day slot → sends OFF, then sleeps.
    const t1 = await relay.assertNextState(false);
    assertBefore(t1, "2026-04-19T10:00", "OFF (gap before charge slot)");

    // 17 hours at 10 000× speedup ≈ 6 s real time — use a generous timeout.
    const t2 = await relay.assertNextState(true, 10_000);
    assertAt(t2, "2026-04-19T10:00", "Second ON (charge slot start)");

    // Session completes (630 ms real for 7 × 15-min slots), loop exits via justOnce.
    await loopPromise;

  } finally {
    relay.cleanup();
    sessionClient.end();
    relayClient.end();
  }
});