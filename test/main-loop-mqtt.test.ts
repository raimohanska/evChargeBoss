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
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { connectMqtt, makeMqttSession } from "../src/mqtt-client.ts";
import { createPublisher } from "../src/mqtt-status.ts";
import { makeClock } from "../src/utils.ts";
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
  const relay = new MqttRelaySimulator(relayClient, config.mqtt!);
  const clock = makeClock(SPEEDUP, FROM);

  try {
    const loopPromise = runMainLoop(session, publisher, config, FROM, errorStatus, clock);

    // waitForStart() sends ON then waits for power readings from the relay simulator.
    await relay.assertNextState(true);

    // runCharging sees a 1h45m gap before the 11:45 slot → sends OFF, then sleeps.
    await relay.assertNextState(false);

    // The 11:45 slot arrives (630 ms real at 10 000× speedup) → ON.
    await relay.assertNextState(true);

    // Session completes (90 ms real for the 15-min slot), loop exits via justOnce.
    await loopPromise;
  } finally {
    relay.cleanup();
    sessionClient.end();
    relayClient.end();
  }
});