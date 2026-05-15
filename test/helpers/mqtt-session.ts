import os from "os";
import path from "path";
import { connectMqtt, makeMqttSession } from "../../src/ev-charging/mqtt-client.ts";
import { StatusPublisher } from "../../src/ev-charging/mqtt-status.ts";
import { makeClock } from "../../src/utils/timing-utils.ts";
import { runSession } from "../../src/ev-charging/coordinator.ts";
import type { Config, MqttConfig } from "../../src/config.ts";
import type { SessionSummary } from "../../src/influx.ts";
import { MqttRelaySimulator } from "./mqtt-relay-simulator.ts";
import { makeTestConfig } from "./config.ts";
import { writePlanFile, planFilePath } from "../../src/utils/plan-store.ts";

// Use a unique plans directory per session to prevent cross-test interference.
let _sessionCounter = 0;

const STATUS_TOPIC = "evchargeboss/status";
const CHARGED_ENERGY_TOPIC = "evchargeboss/charged_energy";
const TARGET_TIME_SET_TOPIC = "evchargeboss/target_time/set";

export interface MqttTestSession {
  loopPromise: Promise<void>;
  relay: MqttRelaySimulator;
  /** Publish a target-time change (HH:MM) via MQTT, triggering an immediate replan. */
  publishTargetTime(time: string): void;
  /**
   * Publish a heating power reading (watts) to the holdWhenHeating topic.
   * Use this to trigger or release a hold during tests.
   * No-op when holdWhenHeating is not configured in chargingOverrides.
   */
  publishHeatingPower(watts: number): void;
  /** Last charged energy (kWh) received from MQTT — 0 if none yet. */
  chargedEnergy(): number;
  /** Session summary captured from onSessionEnd — null until session completes. */
  sessionSummary(): SessionSummary | null;
  /**
   * Deduplicated sequence of status values received via MQTT.
   * Recording starts from the first "Starting…" message emitted by StatusPublisher,
   * discarding any retained values left by a previous test session.
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
  initialPlanData?: object,
  sessionOptions: { suppressPower?: boolean } = {},
): Promise<MqttTestSession> {
  // Isolate plan files per test session so tests don't interfere with each other.
  const sessionId = `${process.pid}-${++_sessionCounter}`;
  process.env.PLANS_DIR = path.join(os.tmpdir(), `evchargeboss-test-plans-${sessionId}`);
  if (initialPlanData !== undefined) {
    writePlanFile(planFilePath("ev-charging", "2026-04-18T17-00-00"), initialPlanData);
  }

  // Give every session its own unique MQTT topics for the charger relay and
  // power readings.  This prevents zombie loops from failed/slow tests from
  // bleeding relay commands into the next test's relay simulator.
  const sessionMqttOverrides: Partial<MqttConfig> = {
    powerTopic: `evchargeboss-test/power-${sessionId}`,
    chargerTopic: `evchargeboss-test/charger-${sessionId}`,
    ...mqttOverrides,
  };
  // Also unique-ify the holdWhenHeating topic when configured, for the same reason.
  let sessionChargingOverrides = chargingOverrides;
  if (chargingOverrides.holdWhenHeating) {
    sessionChargingOverrides = {
      ...chargingOverrides,
      holdWhenHeating: {
        ...chargingOverrides.holdWhenHeating,
        mqtt: {
          ...chargingOverrides.holdWhenHeating.mqtt,
          powerTopic: `${chargingOverrides.holdWhenHeating.mqtt.powerTopic}-${sessionId}`,
        },
      },
    };
  }
  const config = makeTestConfig(sessionChargingOverrides, sessionMqttOverrides);

  // Connect all three MQTT clients in parallel.
  const [sessionClient, relayClient, controlClient] = await Promise.all([
    connectMqtt(config.mqtt!),
    connectMqtt(config.mqtt!),
    connectMqtt(config.mqtt!),
  ]);

  // Track status history from MQTT messages.
  // Only start recording after "Starting…" to discard retained values from previous sessions.
  const _statusHistory: string[] = [];
  let _lastStatus = "";
  let _recording = false;
  let _lastChargedEnergy = 0;
  let _sessionSummary: SessionSummary | null = null;

  // Subscribe controlClient to observable topics BEFORE creating StatusPublisher so we
  // don't miss the "Starting…" retained message from initializeDiscovery().
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      controlClient.subscribe(STATUS_TOPIC, (err) => (err ? reject(err) : resolve()));
    }),
    new Promise<void>((resolve, reject) => {
      controlClient.subscribe(CHARGED_ENERGY_TOPIC, (err) => (err ? reject(err) : resolve()));
    }),
  ]);

  controlClient.on("message", (topic: string, payload: Buffer) => {
    const value = payload.toString();
    if (topic === STATUS_TOPIC) {
      if (!_recording) {
        // Discard any retained messages from a previous session; begin on "Starting…".
        if (value === "Starting...") {
          _recording = true;
          _lastStatus = value;
          _statusHistory.push(value);
        }
      } else if (value !== _lastStatus) {
        _lastStatus = value;
        _statusHistory.push(value);
      }
    } else if (topic === CHARGED_ENERGY_TOPIC) {
      const n = parseFloat(value);
      if (!isNaN(n)) _lastChargedEnergy = n;
    }
  });

  const clock = makeClock(speedup, from);

  // Real StatusPublisher — initializeDiscovery() publishes "Starting…" (retained) which
  // wakes the controlClient subscription above.
  const publisher = new StatusPublisher(sessionClient, config.evCharging);

  const session = makeMqttSession(
    sessionClient,
    config.evCharging.mqtt!,
    publisher,
    clock,
    config.evCharging.holdWhenHeating,
    config.evCharging.plugInTimeoutMs,
  );
  const relay = new MqttRelaySimulator(relayClient, config.evCharging.mqtt!, clock, {
    suppressPower: sessionOptions.suppressPower,
  });

  // Wait for the relay's charger-topic subscription to be confirmed (SUBACK) before
  // starting the main loop.  Without this, coordinator startup detection can publish
  // ON before the relay has subscribed, causing the relay to miss the command.
  await relay.ready;

  // Wrap onSessionEnd to capture the last SessionSummary.
  const wrappedOnSessionEnd = async (summary: SessionSummary) => {
    _sessionSummary = summary;
    await onSessionEnd?.(summary);
  };

  const loopPromise = runSession(session, publisher, config, from, clock, wrappedOnSessionEnd);

  return {
    loopPromise,
    relay,
    publishTargetTime(time: string) {
      controlClient.publish(TARGET_TIME_SET_TOPIC, time);
    },
    publishHeatingPower(watts: number) {
      const h = config.evCharging.holdWhenHeating;
      if (!h) return;
      const { powerTopic, powerField } = h.mqtt;
      const payload =
        powerField !== undefined ? JSON.stringify({ [powerField]: watts }) : String(watts);
      controlClient.publish(powerTopic, payload);
    },
    chargedEnergy: () => _lastChargedEnergy,
    sessionSummary: () => _sessionSummary,
    statusHistory: () => _statusHistory,
    teardown() {
      relay.cleanup();
      // Clear the retained target_time/state so a changed target time in this
      // test cannot bleed into the next test's StatusPublisher startup.
      controlClient.publish("evchargeboss/target_time/state", Buffer.alloc(0), { retain: true });
      // Force-close so the TCP socket is gone before the next test creates new connections.
      sessionClient.end(true);
      relayClient.end(true);
      controlClient.end(true);
    },
  };
}
