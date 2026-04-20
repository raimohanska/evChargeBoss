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

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

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

  // MQTT message delivery adds ~50 ms real time ≈ 8 simulated minutes at 10 000× speedup.
  // All time-based assertions use a 10-minute virtual tolerance to absorb this jitter.
  const TOLERANCE_MS = 10 * 60_000;

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

    // First ON fires immediately at session start (~10:00), before any sleeping.
    assert.ok(
      t0.getTime() - new Date("2026-04-18T10:00:00").getTime() < TOLERANCE_MS,
      `First ON at ${localDateTimeString(t0)}, expected ~10:00`,
    );

    // OFF fires after planning but before the charge slot starts at 11:45.
    assert.ok(
      t1 < new Date("2026-04-18T11:45:00"),
      `OFF at ${localDateTimeString(t1)}, expected before 11:45`,
    );

    // Second ON fires when the plan's first charge slot begins at 11:45.
    assert.ok(
      Math.abs(t2.getTime() - new Date("2026-04-18T11:45:00").getTime()) < TOLERANCE_MS,
      `Second ON at ${localDateTimeString(t2)}, expected ~11:45`,
    );
  } finally {
    relay.cleanup();
    sessionClient.end();
    relayClient.end();
  }
});