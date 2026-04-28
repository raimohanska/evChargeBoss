import { connectMqtt, makeMqttSession } from "../../src/ev-charging/mqtt-client.ts";
import type { Publisher } from "../../src/ev-charging/mqtt-status.ts";
import { createPublisher, shouldSuppressStatus } from "../../src/ev-charging/mqtt-status.ts";
import { makeClock } from "../../src/utils/timing-utils.ts";
import { runSession } from "../../src/ev-charging/main-loop.ts";
import type { Config, MqttConfig } from "../../src/config.ts";
import type { SessionSummary } from "../../src/influx.ts";
import { MqttRelaySimulator } from "./mqtt-relay-simulator.ts";
import { makeTestConfig } from "./config.ts";

export interface MqttTestSession {
  loopPromise: Promise<void>;
  relay: MqttRelaySimulator;
  /** Simulate a target-time change (HH:MM), triggering an immediate replan. */
  publishTargetTime(time: string): void;
  /** Last value passed to publisher.setChargedEnergy() — 0 if never called. */
  chargedEnergy(): number;
  /** Last value passed to publisher.setAccumulatedCost() — 0 if never called. */
  accumulatedCost(): number;
  /** Last value passed to publisher.setAccumulatedSolarPct() — 0 if never called. */
  accumulatedSolarPct(): number;
  /**
   * Deduplicated sequence of status values that were actually published
   * (suppressed flicker entries excluded, consecutive duplicates collapsed).
   */
  statusHistory(): readonly string[];
  teardown(): void;
}

export async function startMqttSession(
  from: Date,
  speedup: number,
  chargingOverrides: Partial<Omit<Config["evCharging"], "mode" | "mqtt">> = {},
  mqttOverrides: Partial<MqttConfig> = {},
  onSessionEnd?: (summary: SessionSummary) => Promise<void>,
): Promise<MqttTestSession> {
  const config = makeTestConfig(chargingOverrides, mqttOverrides);
  const [sessionClient, relayClient] = await Promise.all([
    connectMqtt(config.mqtt!),
    connectMqtt(config.mqtt!),
  ]);

  // Wrap LoggingPublisher to intercept target-time override and replan callback.
  // publishTargetTime() can then trigger a replan directly without an extra MQTT
  // connection — the full MQTT target-time path is exercised by StatusPublisher
  // in production; here we test the replan logic itself.
  let targetTimeOverride: string | null = null;
  let replanCb: (() => void) | null = null;
  let lastChargedEnergy = 0;
  let lastAccumulatedCost = 0;
  let lastAccumulatedSolarPct = 0;
  // Track the effective (post-suppression, deduplicated) status sequence.
  const _statusHistory: string[] = [];
  let _lastStatus = "";
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
    setStatus: (s) => {
      if (!shouldSuppressStatus(_lastStatus, s)) {
        _lastStatus = s;
        if (_statusHistory.length === 0 || _statusHistory[_statusHistory.length - 1] !== s) {
          _statusHistory.push(s);
        }
      }
      base.setStatus(s);
    },
    setError: (m) => base.setError(m),
    setPlan: (s) => base.setPlan(s),
    setChargedEnergy: (k) => {
      lastChargedEnergy = k;
      base.setChargedEnergy(k);
    },
    setAccumulatedCost: (e) => {
      lastAccumulatedCost = e;
      base.setAccumulatedCost(e);
    },
    setAccumulatedSolarPct: (p) => {
      lastAccumulatedSolarPct = p;
      base.setAccumulatedSolarPct(p);
    },
  };

  const session = makeMqttSession(sessionClient, config.evCharging.mqtt!, publisher);
  const clock = makeClock(speedup, from);
  const relay = new MqttRelaySimulator(relayClient, config.evCharging.mqtt!, clock);

  // Wait for the relay's charger-topic subscription to be confirmed (SUBACK) before
  // starting the main loop.  Without this, waitForStart() can publish ON before the
  // relay has subscribed, causing the relay to miss the command permanently.
  await relay.ready;

  const loopPromise = runSession(session, publisher, config, from, clock, onSessionEnd);

  return {
    loopPromise,
    relay,
    publishTargetTime(time: string) {
      targetTimeOverride = time;
      replanCb?.();
    },
    chargedEnergy: () => lastChargedEnergy,
    accumulatedCost: () => lastAccumulatedCost,
    accumulatedSolarPct: () => lastAccumulatedSolarPct,
    statusHistory: () => _statusHistory,
    teardown() {
      relay.cleanup();
      // Force-close so the TCP socket is gone before the next test creates new connections.
      sessionClient.end(true);
      relayClient.end(true);
    },
  };
}
