import { connectMqtt, makeMqttSession } from "../../src/ev-charging/mqtt-client.ts";
import type { Publisher } from "../../src/ev-charging/mqtt-status.ts";
import { createPublisher } from "../../src/ev-charging/mqtt-status.ts";
import { makeClock } from "../../src/utils.ts";
import { runSession } from "../../src/ev-charging/main-loop.ts";
import type { Config, MqttConfig } from "../../src/config.ts";
import { MqttRelaySimulator } from "./mqtt-relay-simulator.ts";
import { makeTestConfig } from "./config.ts";

export interface MqttTestSession {
  loopPromise: Promise<void>;
  relay: MqttRelaySimulator;
  /** Simulate a target-time change (HH:MM), triggering an immediate replan. */
  publishTargetTime(time: string): void;
  /** Last value passed to publisher.setChargedEnergy() — 0 if never called. */
  chargedEnergy(): number;
  teardown(): void;
}

export async function startMqttSession(
  from: Date,
  speedup: number,
  chargingOverrides: Partial<Config["evCharging"]["charging"]> = {},
  mqttOverrides: Partial<MqttConfig> = {},
): Promise<MqttTestSession> {
  const config = makeTestConfig(chargingOverrides, mqttOverrides);
  const [sessionClient, relayClient] = await Promise.all([
    connectMqtt(config.evCharging.charging.mqtt!),
    connectMqtt(config.evCharging.charging.mqtt!),
  ]);

  // Wrap LoggingPublisher to intercept target-time override and replan callback.
  // publishTargetTime() can then trigger a replan directly without an extra MQTT
  // connection — the full MQTT target-time path is exercised by StatusPublisher
  // in production; here we test the replan logic itself.
  let targetTimeOverride: string | null = null;
  let replanCb: (() => void) | null = null;
  let lastChargedEnergy = 0;
  const base = createPublisher(config.evCharging);
  const publisher: Publisher = {
    setReplanCallback: (cb) => {
      replanCb = cb;
    },
    getTargetTimeOverride: () => targetTimeOverride,
    resetTargetTime: () => {
      targetTimeOverride = null;
      base.resetTargetTime();
    },
    setStatus: (s) => base.setStatus(s),
    setError: (m) => base.setError(m),
    setPlan: (s) => base.setPlan(s),
    setChargedEnergy: (k) => {
      lastChargedEnergy = k;
      base.setChargedEnergy(k);
    },
  };

  const session = makeMqttSession(sessionClient, config.evCharging.charging.mqtt!, publisher);
  const clock = makeClock(speedup, from);
  const relay = new MqttRelaySimulator(relayClient, config.evCharging.charging.mqtt!, clock);

  // Wait for the relay's charger-topic subscription to be confirmed (SUBACK) before
  // starting the main loop.  Without this, waitForStart() can publish ON before the
  // relay has subscribed, causing the relay to miss the command permanently.
  await relay.ready;

  const loopPromise = runSession(session, publisher, config.evCharging, from, clock);

  return {
    loopPromise,
    relay,
    publishTargetTime(time: string) {
      targetTimeOverride = time;
      replanCb?.();
    },
    chargedEnergy: () => lastChargedEnergy,
    teardown() {
      relay.cleanup();
      // Force-close so the TCP socket is gone before the next test creates new connections.
      sessionClient.end(true);
      relayClient.end(true);
    },
  };
}
