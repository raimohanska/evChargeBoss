/**
 * Integration test: main loop drives a real MQTT broker.
 *
 * Requires a Mosquitto broker on localhost:1883.
 * Start one with: docker compose up -d
 *
 * Scenario
 * --------
 * from = 2026-04-18T10:00, targetTime = "12:00", targetKwh = 0.75 (1 slot).
 * The cheapest single slot in that window is 11:45 (lowest spot price + high solar).
 * Because the first charge slot is not at 10:00, runCharging sends:
 *
 *   ON  ← waitForStart() announces the charger is ready and waits for plug-in
 *   OFF ← runCharging sleeps through the 10:00-11:45 gap with charger off
 *   ON  ← 11:45 charge slot starts
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



const FROM = new Date("2026-04-18T10:00:00");
const SPEEDUP = 10_000;

function makeTestConfig(): Config {
  const base = loadConfig();
  return {
    ...base,
    mode: "charge" as const,
    mqtt: { ...base.mqtt!, brokerUrl: "mqtt://localhost:1883" },
    charging: { ...base.charging, targetKwh: 0.75 },
    test: { timeSpeedupFactor: SPEEDUP, justOnce: true },
  };
}

test("Plan for the 10:00 session: 1 charge slot at 11:45", async () => {
  const config = makeTestConfig();
  const targetDate = parseTargetTime(config.charging.targetTime, FROM);
  const slots = await plan(FROM, targetDate, config.charging.targetKwh, config);

  const chargeSlots = slots.filter(s => s.charge);
  assert.equal(chargeSlots.length, 1, "exactly 1 charge slot for 0.75 kWh");

  const chargeSlot = chargeSlots[0];
  assert.equal(chargeSlot.start.getHours(), 11, "charge slot starts at hour 11");
  assert.equal(chargeSlot.start.getMinutes(), 45, "charge slot starts at minute 45");
  assert.equal(chargeSlot.end.getHours(), 12, "charge slot ends at 12:00");
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
    assertAt(t0, "10:00", "First ON (session start)");

    // runCharging sees a gap before the 11:45 slot → sends OFF, then sleeps.
    const t1 = await relay.assertNextState(false);
    assertBefore(t1, "11:45", "OFF (gap before charge slot)");

    // The 11:45 slot arrives → ON.
    const t2 = await relay.assertNextState(true);
    assertAt(t2, "11:45", "Second ON (charge slot start)");

    // Session completes (90 ms real for the 15-min slot), loop exits via justOnce.
    await loopPromise;

  } finally {
    relay.cleanup();
    sessionClient.end();
    relayClient.end();
  }
});