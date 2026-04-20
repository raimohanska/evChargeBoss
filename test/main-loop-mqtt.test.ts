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
import { makeClock, localDateTimeString } from "../src/utils.ts";
import { runMainLoop } from "../src/main-loop.ts";
import { IncompleteDataError } from "../src/errors.ts";
import { STATUS } from "../src/mqtt-status.ts";
import { MqttRelaySimulator } from "./mqtt-relay-simulator.ts";

// Assert that a relay event time is within TOLERANCE_MS of a local HH:MM on 2026-04-18.
function assertAt(actual: Date, expectedTime: string, label: string): void {
  const expected = new Date(`2026-04-18T${expectedTime}:00`);
  const TOLERANCE_MS = 10 * 60_000; // 10 virtual minutes — absorbs MQTT roundtrip jitter
  assert.ok(
    Math.abs(actual.getTime() - expected.getTime()) < TOLERANCE_MS,
    `${label}: got ${localDateTimeString(actual)}, expected ~${expectedTime}`,
  );
}

function assertBefore(actual: Date, expectedTime: string, label: string): void {
  const expected = new Date(`2026-04-18T${expectedTime}:00`);
  assert.ok(
    actual < expected,
    `${label}: got ${localDateTimeString(actual)}, expected before ${expectedTime}`,
  );
}



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

    // runCharging sees a gap before the 11:45 slot → sends OFF, then sleeps.
    const t1 = await relay.assertNextState(false);

    // The 11:45 slot arrives → ON.
    const t2 = await relay.assertNextState(true);

    // Session completes (90 ms real for the 15-min slot), loop exits via justOnce.
    await loopPromise;

    assertAt(t0, "10:00", "First ON (session start)");
    assertBefore(t1, "11:45", "OFF (gap before charge slot)");
    assertAt(t2, "11:45", "Second ON (charge slot start)");
  } finally {
    relay.cleanup();
    sessionClient.end();
    relayClient.end();
  }
});