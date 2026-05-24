import type { MqttClient } from "./mqtt-client.ts";
import type { EvChargingConfig } from "./config.ts";
import type { Slot } from "./types.ts";
import { makeLogger } from "../utils/log.ts";
import { resolveTargetTime, formatHHMM } from "./helpers.ts";

const log = makeLogger("ev-charging");

const DEVICE_ID = "evchargeboss";
const BASE = "evchargeboss";
const DISCOVERY = "homeassistant";

const DEVICE = {
  identifiers: [DEVICE_ID],
  name: "EV Charge Boss",
};

interface SensorDef {
  id: string;
  name: string;
  icon: string;
  unit?: string;
  state_class?: string;
}

const SENSORS: SensorDef[] = [
  { id: "status", name: "Status", icon: "mdi:ev-station" },
  {
    id: "plan_cost",
    name: "Estimated Charge Cost (EUR)",
    icon: "mdi:currency-eur",
  },
  { id: "solar_pct", name: "Solar Power Share (%)", icon: "mdi:solar-power" },
  {
    id: "charged_energy",
    name: "Charged Energy (kWh)",
    icon: "mdi:lightning-bolt",
  },
];

function stateTopic(id: string) {
  return `${BASE}/${id}`;
}
function discoveryTopic(id: string) {
  return `${DISCOVERY}/sensor/${DEVICE_ID}_${id}/config`;
}

export class StatusPublisher {
  private client: MqttClient;
  private config: EvChargingConfig;
  private targetTimeOverride: string | null = null;
  private readonly timeStateTopic = `${BASE}/target_time/state`;
  private _resolveInitialTargetTime: (() => void) | null = null;
  private targetKwhOverride: number | null = null;
  private readonly kwhStateTopic = `${BASE}/target_kwh/state`;
  private _resolveInitialTargetKwh: (() => void) | null = null;

  constructor(client: MqttClient, config: EvChargingConfig) {
    this.client = client;
    this.config = config;
    this.initializeDiscovery();
  }

  private wakeCallback: (() => void) | null = null;
  private chargeNowCallback: (() => void) | null = null;

  setWakeCallback(cb: () => void): void {
    this.wakeCallback = cb;
  }

  setChargeNowCallback(cb: () => void): void {
    this.chargeNowCallback = cb;
  }

  getTargetTimeOverride(): string | null {
    return this.targetTimeOverride;
  }

  getTargetKwhOverride(): number | null {
    return this.targetKwhOverride;
  }

  resetTargetTime(now: Date): void {
    this.targetTimeOverride = null;
    // Publish the schedule-aware default so HA shows the correct next target
    // time instead of retaining the stale Charge Now override.
    const resolved = resolveTargetTime(this.config.targetTime, this.config.weeklySchedule, now);
    this.pub(this.timeStateTopic, formatHHMM(resolved));
  }

  resetTargetKwh(): void {
    this.targetKwhOverride = null;
    this.pub(this.kwhStateTopic, String(this.config.targetKwh));
  }

  /**
   * Waits up to `timeoutMs` for the broker to deliver a retained target-kwh
   * override, then publishes the confirmed value to the state topic.
   * Must be called once after construction and before runSession().
   */
  async waitForInitialTargetKwh(timeoutMs = 2000): Promise<void> {
    await new Promise<void>((resolve) => {
      this._resolveInitialTargetKwh = resolve;
      setTimeout(() => {
        if (this._resolveInitialTargetKwh !== null) {
          this._resolveInitialTargetKwh = null;
          log(
            `[MQTT] No retained target kWh within ${timeoutMs}ms - using ${this.config.targetKwh} kWh`,
          );
          resolve();
        }
      }, timeoutMs);
    });
    this.pub(this.kwhStateTopic, String(this.targetKwhOverride ?? this.config.targetKwh));
  }

  /**
   * Waits up to `timeoutMs` for the broker to deliver a retained target-time
   * override, then publishes the confirmed value to the state topic.
   * Must be called once after construction and before runSession().
   */
  async waitForInitialTargetTime(timeoutMs = 2000): Promise<void> {
    await new Promise<void>((resolve) => {
      this._resolveInitialTargetTime = resolve;
      setTimeout(() => {
        if (this._resolveInitialTargetTime !== null) {
          this._resolveInitialTargetTime = null;
          const defaultTime = resolveTargetTime(
            this.config.targetTime,
            this.config.weeklySchedule,
            new Date(),
          );
          log(
            `[MQTT] No retained target time within ${timeoutMs}ms - using ${formatHHMM(defaultTime)}`,
          );
          resolve();
        }
      }, timeoutMs);
    });
    // Now publish the confirmed value (deferred from initializeDiscovery).
    const fallback = resolveTargetTime(
      this.config.targetTime,
      this.config.weeklySchedule,
      new Date(),
    );
    this.pub(this.timeStateTopic, this.targetTimeOverride ?? formatHHMM(fallback));
  }

  private state: Record<string, string> = {
    status: "Starting...",
    plan_cost: "-",
    solar_pct: "-",
    charged_energy: "-",
  };

  private initializeDiscovery(): void {
    for (const s of SENSORS) {
      const config: Record<string, unknown> = {
        unique_id: `${DEVICE_ID}_${s.id}`,
        name: s.name,
        state_topic: stateTopic(s.id),
        icon: s.icon,
        device: DEVICE,
        ...(s.unit && { unit_of_measurement: s.unit }),
        ...(s.state_class && { state_class: s.state_class }),
      };
      this.pub(discoveryTopic(s.id), JSON.stringify(config), true);
    }
    for (const s of SENSORS) {
      this.pub(stateTopic(s.id), this.state[s.id]);
    }

    // HA text entity for target charge time (HH:MM input with pattern validation)
    const timeCmdTopic = `${BASE}/target_time/set`;
    const timeStateTopic = this.timeStateTopic;
    const timeDiscoveryTopic = `${DISCOVERY}/text/${DEVICE_ID}_target_time/config`;
    const timeDiscoveryPayload = JSON.stringify({
      unique_id: `${DEVICE_ID}_target_time`,
      name: "Charge Target Time",
      icon: "mdi:clock-end",
      state_topic: timeStateTopic,
      command_topic: timeCmdTopic,
      pattern: "^([01]?[0-9]|2[0-3]):[0-5][0-9]$",
      device: DEVICE,
    });
    // Clear stale retained messages from removed/renamed entities
    this.pub(`${DISCOVERY}/sensor/${DEVICE_ID}_next_charge/config`, "", true);
    this.pub(stateTopic("next_charge"), "", true);
    // Remove any previously-retained `time` discovery (old entity type, now replaced by `text`)
    this.pub(`${DISCOVERY}/time/${DEVICE_ID}_target_time/config`, "", true);
    this.pub(timeDiscoveryTopic, timeDiscoveryPayload, true);

    // HA number entity for target charge energy (kWh)
    const kwhCmdTopic = `${BASE}/target_kwh/set`;
    const kwhStateTopic = this.kwhStateTopic;
    const kwhDiscoveryTopic = `${DISCOVERY}/number/${DEVICE_ID}_target_kwh/config`;
    const kwhDiscoveryPayload = JSON.stringify({
      unique_id: `${DEVICE_ID}_target_kwh`,
      name: "Charge Energy Target (kWh)",
      icon: "mdi:battery-charging-80",
      state_topic: kwhStateTopic,
      command_topic: kwhCmdTopic,
      min: 0.5,
      max: 100,
      step: 0.5,
      unit_of_measurement: "kWh",
      device: DEVICE,
    });
    this.pub(kwhDiscoveryTopic, kwhDiscoveryPayload, true);

    // HA button entity: "Charge Now" — sets target time to now + chargeNowHours
    const chargeNowCmdTopic = `${BASE}/charge_now/set`;
    const chargeNowHours = this.config.chargeNowHours ?? 2;
    const chargeNowDiscoveryPayload = JSON.stringify({
      unique_id: `${DEVICE_ID}_charge_now`,
      name: `Charge Now (+${chargeNowHours}h)`,
      icon: "mdi:flash",
      command_topic: chargeNowCmdTopic,
      payload_press: "PRESS",
      device: DEVICE,
    });
    this.pub(`${DISCOVERY}/button/${DEVICE_ID}_charge_now/config`, chargeNowDiscoveryPayload, true);

    // Subscribe to our own state topic first so we can recover any retained override
    // before publishing the initial state (see waitForInitialTargetTime).
    this.client.subscribe(timeStateTopic, (err) => {
      if (err) log(`[MQTT status] subscribe error: ${err.message}`);
    });
    this.client.subscribe(timeCmdTopic, (err) => {
      if (err) log(`[MQTT status] subscribe error: ${err.message}`);
    });
    this.client.subscribe(kwhStateTopic, (err) => {
      if (err) log(`[MQTT status] subscribe error: ${err.message}`);
    });
    this.client.subscribe(kwhCmdTopic, (err) => {
      if (err) log(`[MQTT status] subscribe error: ${err.message}`);
    });
    this.client.subscribe(chargeNowCmdTopic, (err) => {
      if (err) log(`[MQTT status] subscribe error: ${err.message}`);
    });
    this.client.on("message", (topic: string, payload: Buffer) => {
      if (topic === timeStateTopic && this._resolveInitialTargetTime !== null) {
        // Retained startup value — recover the override before we publish ours.
        const parts = payload.toString().trim().split(":");
        if (parts.length >= 2) {
          const override = `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
          this.targetTimeOverride = override;
        }
        const resolve = this._resolveInitialTargetTime;
        this._resolveInitialTargetTime = null;
        resolve();
      } else if (topic === timeCmdTopic) {
        const parts = payload.toString().trim().split(":");
        if (parts.length < 2) return;
        const newTime = `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
        this.targetTimeOverride = newTime;
        log(`[MQTT] Target time updated to ${newTime}`);
        this.pub(timeStateTopic, newTime);
        this.wakeCallback?.();
      } else if (topic === kwhStateTopic && this._resolveInitialTargetKwh !== null) {
        const v = parseFloat(payload.toString().trim());
        if (v > 0) {
          this.targetKwhOverride = v;
        }
        const resolve = this._resolveInitialTargetKwh;
        this._resolveInitialTargetKwh = null;
        resolve();
      } else if (topic === kwhCmdTopic) {
        const v = parseFloat(payload.toString().trim());
        if (!isFinite(v) || v <= 0) return;
        this.targetKwhOverride = v;
        log(`[MQTT] Target kWh updated to ${v}`);
        this.pub(kwhStateTopic, String(v));
        this.wakeCallback?.();
      } else if (topic === chargeNowCmdTopic && payload.toString().trim() === "PRESS") {
        const target = new Date(Date.now() + chargeNowHours * 3_600_000);
        const newTime = `${String(target.getHours()).padStart(2, "0")}:${String(target.getMinutes()).padStart(2, "0")}`;
        this.targetTimeOverride = newTime;
        log(`[MQTT] Charge Now pressed -> target time set to ${newTime}`);
        this.pub(timeStateTopic, newTime);
        this.chargeNowCallback?.();
        this.wakeCallback?.();
      }
    });

    //log("MQTT discovery and initial state published.");
  }

  setStatus(status: string): void {
    if (this.state.status === status) return;
    log(`[Status] ${status}`);
    this.setState("status", status);
  }

  setError(message: string): void {
    log(`[Status] ${message}`);
    this.setState("status", message);
  }

  setPlan(slots: Slot[]): void {
    const charge = slots.filter((s) => s.charge);
    const cost = charge.reduce((sum, s) => sum + s.effectiveCostEur, 0);
    const powerKw = this.config.powerKw ?? 1;
    const totalSolarFraction = charge.reduce(
      (sum, s) => sum + Math.min(1, s.solarForecastW / 1000 / powerKw),
      0,
    );
    const pct = charge.length > 0 ? Math.round((totalSolarFraction / charge.length) * 100) : 0;
    this.setState("plan_cost", cost.toFixed(2));
    this.setState("solar_pct", String(pct));
  }

  clearPlan(): void {
    this.setState("plan_cost", "-");
    this.setState("solar_pct", "-");
  }

  setChargedEnergy(kwh: number): void {
    this.setState("charged_energy", kwh.toFixed(2));
  }

  private setState(id: string, value: string): void {
    this.state[id] = value;
    this.pub(stateTopic(id), value);
  }

  private pub(topic: string, payload: string, retain = true): void {
    if (!this.client) return;
    this.client.publish(topic, payload, { retain }, (err) => {
      if (err) log(`[MQTT status] publish error on ${topic}: ${err.message}`);
    });
  }
}
