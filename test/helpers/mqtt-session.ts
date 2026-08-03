import os from "os";
import path from "path";
import { connectMqtt, makeMqttSession } from "../../src/ev-charging/mqtt-client.ts";
import { StatusPublisher } from "../../src/ev-charging/mqtt-status.ts";
import { makeClock } from "../../src/utils/timing-utils.ts";
import { Canceller } from "../../src/utils/timing-utils.ts";
import { runSession } from "../../src/ev-charging/coordinator.ts";
import type { Config, MqttConfig } from "../../src/config.ts";
import type { DayOfWeek } from "../../src/ev-charging/config.ts";
import type { SessionSummary } from "../../src/influx.ts";
import { MqttRelaySimulator } from "./mqtt-relay-simulator.ts";
import { makeTestConfig } from "./config.ts";
import { writePlanFile, planFilePath } from "../../src/utils/plan-store.ts";

// Give every session a unique MQTT topic prefix and plans directory so tests can
// run concurrently without cross-talk or plan-file collisions.
let _sessionCounter = 0;

export interface MqttTestSession {
  loopPromise: Promise<void>;
  relay: MqttRelaySimulator;
  /** Publish a target-time change (HH:MM) via MQTT, triggering an immediate replan. */
  publishTargetTime(time: string): void;
  /** Publish a target-kWh change via MQTT, triggering an immediate replan. */
  publishTargetKwh(kwh: number): void;
  /** Publish a per-day schedule time (HH:MM or HH:MM:SS) via MQTT. */
  publishScheduleTime(day: DayOfWeek, time: string): void;
  /** Last value of a per-day schedule state topic received via MQTT — null if none yet. */
  scheduleState(day: DayOfWeek): string | null;
  /**
   * Publish a heating power reading (watts) to the holdWhenHeating topic.
   * Use this to trigger or release a hold during tests.
   * No-op when holdWhenHeating is not configured in chargingOverrides.
   */
  publishHeatingPower(watts: number): void;
  /**
   * Publish a charge level (battery SoC %) to the chargeLevelTopic.
   * No-op when chargeLevelTopic is not configured in mqttOverrides.
   */
  publishChargeLevel(pct: number): void;
  /** Last charged energy (kWh) received from MQTT — 0 if none yet. */
  chargedEnergy(): number;
  /** Session summary captured from onSessionEnd — null until session completes. */
  sessionSummary(): SessionSummary | null;
  /** Last value of the target_time/state topic received via MQTT — null if none yet. */
  targetTimeState(): string | null;
  /** Last value of the target_kwh/state topic received via MQTT — null if none yet. */
  targetKwhState(): number | null;
  /**
   * Deduplicated sequence of status values received via MQTT.
   * Recording starts from the first "Starting..." message emitted by StatusPublisher,
   * discarding any retained values left by a previous test session.
   */
  statusHistory(): readonly string[];
  teardown(): void;
  /** Stop a session that never ends on its own (e.g. no car plugged in). */
  abort(): void;
}

export async function startMqttSession(
  from: Date,
  speedup: number,
  chargingOverrides: Partial<Omit<Config["evCharging"], "mode" | "mqtt">> = {},
  mqttOverrides: Partial<MqttConfig> = {},
  onSessionEnd?: (summary: SessionSummary) => Promise<void>,
  initialPlanData?: object,
  sessionOptions: {
    suppressPower?: boolean;
    holdThreshold?: number;
    /**
     * Retained schedule values to pre-publish before StatusPublisher starts,
     * so waitForInitialWeeklySchedule recovers them. Also enables the wait.
     */
    initialScheduleState?: Partial<Record<DayOfWeek, string>>;
    /** Optional config file path passed to StatusPublisher for write-back. */
    configPath?: string;
  } = {},
): Promise<MqttTestSession> {
  // Isolate plan files per test session so tests don't interfere with each other.
  const sessionId = `${process.pid}-${++_sessionCounter}`;
  const plansDir = path.join(os.tmpdir(), `evchargeboss-test-plans-${sessionId}`);
  if (initialPlanData !== undefined) {
    writePlanFile(planFilePath("ev-charging", "2026-04-18T17-00-00", plansDir), initialPlanData);
  }

  // Unique MQTT topic prefix for every observable topic this session publishes
  // or subscribes to (status, target_time, target_kwh, schedule, discovery).
  const topicPrefix = `evchargeboss-test-${sessionId}`;
  const STATUS_TOPIC = `${topicPrefix}/status`;
  const CHARGED_ENERGY_TOPIC = `${topicPrefix}/charged_energy`;
  const TARGET_TIME_SET_TOPIC = `${topicPrefix}/target_time/set`;
  const TARGET_TIME_STATE_TOPIC = `${topicPrefix}/target_time/state`;
  const TARGET_KWH_SET_TOPIC = `${topicPrefix}/target_kwh/set`;
  const TARGET_KWH_STATE_TOPIC = `${topicPrefix}/target_kwh/state`;
  const WEEKDAYS: readonly DayOfWeek[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  const scheduleStateTopic = (day: DayOfWeek) => `${topicPrefix}/schedule/${day}/state`;
  const scheduleSetTopic = (day: DayOfWeek) => `${topicPrefix}/schedule/${day}/set`;

  // Give every session its own unique MQTT topics for the charger relay and
  // power readings.  This prevents zombie loops from failed/slow tests from
  // bleeding relay commands into the next test's relay simulator.
  const sessionMqttOverrides: Partial<MqttConfig> = {
    powerTopic: `evchargeboss-test/power-${sessionId}`,
    chargerTopic: `evchargeboss-test/charger-${sessionId}`,
    ...mqttOverrides,
  };
  // Also unique-ify the holdWhenHeating topic when configured, for the same reason.
  let sessionChargingOverrides: Partial<Omit<Config["evCharging"], "mode" | "mqtt">> = {
    ...chargingOverrides,
    topicPrefix,
  };
  if (chargingOverrides.holdWhenHeating) {
    sessionChargingOverrides = {
      ...sessionChargingOverrides,
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
  let _lastTargetTimeState: string | null = null;
  let _lastTargetKwhState: number | null = null;
  const _lastScheduleState = new Map<DayOfWeek, string>();

  // Subscribe controlClient to observable topics BEFORE creating StatusPublisher so we
  // don't miss the "Starting…" retained message from initializeDiscovery().
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      controlClient.subscribe(STATUS_TOPIC, (err) => (err ? reject(err) : resolve()));
    }),
    new Promise<void>((resolve, reject) => {
      controlClient.subscribe(CHARGED_ENERGY_TOPIC, (err) => (err ? reject(err) : resolve()));
    }),
    new Promise<void>((resolve, reject) => {
      controlClient.subscribe(TARGET_TIME_STATE_TOPIC, (err) => (err ? reject(err) : resolve()));
    }),
    new Promise<void>((resolve, reject) => {
      controlClient.subscribe(TARGET_KWH_STATE_TOPIC, (err) => (err ? reject(err) : resolve()));
    }),
    ...WEEKDAYS.map(
      (day) =>
        new Promise<void>((resolve, reject) => {
          controlClient.subscribe(scheduleStateTopic(day), (err) =>
            err ? reject(err) : resolve(),
          );
        }),
    ),
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
    } else if (topic === TARGET_TIME_STATE_TOPIC && value.length > 0) {
      _lastTargetTimeState = value;
    } else if (topic === TARGET_KWH_STATE_TOPIC && value.length > 0) {
      const n = parseFloat(value);
      if (!isNaN(n)) _lastTargetKwhState = n;
    } else {
      const day = WEEKDAYS.find((d) => topic === scheduleStateTopic(d));
      if (day && value.length > 0) _lastScheduleState.set(day, value);
    }
  });

  // Pre-publish retained schedule values so waitForInitialWeeklySchedule can
  // recover them (simulates a previous run that had persisted schedule edits).
  for (const [day, time] of Object.entries(sessionOptions.initialScheduleState ?? {})) {
    controlClient.publish(scheduleStateTopic(day as DayOfWeek), time, { retain: true });
  }

  // Real StatusPublisher — initializeDiscovery() publishes "Starting…" (retained) which
  // wakes the controlClient subscription above.
  const publisher = new StatusPublisher(
    sessionClient,
    config.evCharging,
    sessionOptions.configPath,
  );
  if (sessionOptions.initialScheduleState) {
    await publisher.waitForInitialWeeklySchedule(2000);
  }

  // Create the virtual clock only after the retained-recovery wait: the clock
  // advances with real elapsed time × speedup, so waiting 2000ms at 4 000×
  // would otherwise shift every relay timestamp forward by ~2.2 hours.
  const clock = makeClock(speedup, from);

  const session = makeMqttSession(
    sessionClient,
    config.evCharging.mqtt!,
    publisher,
    clock,
    config.evCharging.holdWhenHeating,
    config.evCharging.plugInTimeoutMs,
    config.evCharging.holdWhenHeating && sessionOptions.holdThreshold !== undefined
      ? () => sessionOptions.holdThreshold!
      : config.evCharging.holdWhenHeating
        ? () => null
        : undefined,
  );
  const relay = new MqttRelaySimulator(relayClient, config.evCharging.mqtt!, clock, {
    suppressPower: sessionOptions.suppressPower,
  });

  // Abort handle for sessions that never end on their own (no car plugged in).
  const sessionCanceller = new Canceller();

  // Wait for the relay's charger-topic subscription to be confirmed (SUBACK) before
  // starting the main loop.  Without this, coordinator startup detection can publish
  // ON before the relay has subscribed, causing the relay to miss the command.
  await relay.ready;

  // Wrap onSessionEnd to capture the last SessionSummary.
  const wrappedOnSessionEnd = async (summary: SessionSummary) => {
    _sessionSummary = summary;
    await onSessionEnd?.(summary);
  };

  const loopPromise = runSession(
    session,
    publisher,
    config,
    undefined,
    clock,
    wrappedOnSessionEnd,
    undefined,
    plansDir,
    sessionCanceller.signal,
  );

  return {
    loopPromise,
    relay,
    publishTargetTime(time: string) {
      controlClient.publish(TARGET_TIME_SET_TOPIC, time);
    },
    publishTargetKwh(kwh: number) {
      controlClient.publish(TARGET_KWH_SET_TOPIC, String(kwh));
    },
    publishScheduleTime(day: DayOfWeek, time: string) {
      controlClient.publish(scheduleSetTopic(day), time);
    },
    scheduleState: (day: DayOfWeek) => _lastScheduleState.get(day) ?? null,
    publishHeatingPower(watts: number) {
      const h = config.evCharging.holdWhenHeating;
      if (!h) return;
      const { powerTopic, powerField } = h.mqtt;
      const payload =
        powerField !== undefined ? JSON.stringify({ [powerField]: watts }) : String(watts);
      controlClient.publish(powerTopic, payload);
    },
    publishChargeLevel(pct: number) {
      const topic = config.evCharging.mqtt?.chargeLevelTopic;
      if (!topic) return;
      const field = config.evCharging.mqtt?.chargeLevelField;
      const payload = field !== undefined ? JSON.stringify({ [field]: pct }) : String(pct);
      controlClient.publish(topic, payload);
    },
    chargedEnergy: () => _lastChargedEnergy,
    sessionSummary: () => _sessionSummary,
    targetTimeState: () => _lastTargetTimeState,
    targetKwhState: () => _lastTargetKwhState,
    statusHistory: () => _statusHistory,
    abort() {
      sessionCanceller.abort();
    },
    teardown() {
      relay.cleanup();
      // Clear the retained target_time/state so a changed target time in this
      // test cannot bleed into the next test's StatusPublisher startup.
      controlClient.publish(TARGET_TIME_STATE_TOPIC, Buffer.alloc(0), { retain: true });
      // Clear the retained target_kwh/state for the same reason.
      controlClient.publish(TARGET_KWH_STATE_TOPIC, Buffer.alloc(0), { retain: true });
      // Clear retained per-day schedule states for the same reason.
      for (const day of WEEKDAYS) {
        controlClient.publish(scheduleStateTopic(day), Buffer.alloc(0), { retain: true });
      }
      // Force-close so the TCP socket is gone before the next test creates new connections.
      sessionClient.end(true);
      relayClient.end(true);
      controlClient.end(true);
    },
  };
}
