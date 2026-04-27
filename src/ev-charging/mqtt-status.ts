import type { MqttClient } from "./mqtt-client.ts";
import type { EvChargingConfig } from "./config.ts";
import type { Slot } from "./types.ts";
import { log } from "../utils/log.ts";

// All possible status values. Static states are plain strings; dynamic ones are functions.
export const STATUS = {
  starting: "Starting...",
  waitingForCar: "Waiting for car to be plugged in",
  fetchingData: "Fetching data...",
  waitingForSpot: "Waiting for spot prices",
  waitingForSolar: "Waiting for solar forecast",
  mqttError: "MQTT connection error",
  idle: "Idle",
  plannedChargeStart: (time: string) => `Planned charge start at ${time}`,
  waitingForChargingToStart: "Waiting for charging to start",
  charging: (until: string) => `Charging until ${until}`,
  chargingFinished: "Charging finished",
  chargePaused: (next: string) => `Charge paused, next slot at ${next}`,
  error: (msg: string) => msg,
} as const;

// Common interface for publishers
export interface Publisher {
  setReplanCallback(cb: () => void): void;
  resetTargetTime(): void;
  getTargetTimeOverride(): string | null;
  setStatus(status: string): void;
  setError(message: string): void;
  setPlan(slots: Slot[]): void;
  setChargedEnergy(kwh: number): void;
  setAccumulatedCost(eur: number): void;
  setAccumulatedSolarPct(pct: number): void;
}

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
    name: "Estimated Charge Cost (\u20ac)",
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

export class StatusPublisher implements Publisher {
  private client: MqttClient;
  private config: EvChargingConfig;
  private targetTimeOverride: string | null = null;
  private lastLoggedStatus = "";
  private accumulatedCostEur = 0;

  constructor(client: MqttClient, config: EvChargingConfig) {
    this.client = client;
    this.config = config;
    this.initializeDiscovery();
  }

  private replanCallback: (() => void) | null = null;

  setReplanCallback(cb: () => void): void {
    this.replanCallback = cb;
  }

  getTargetTimeOverride(): string | null {
    return this.targetTimeOverride;
  }

  resetTargetTime(): void {
    this.targetTimeOverride = null;
    this.pub(`${BASE}/target_time/state`, this.config.targetTime);
  }

  private state: Record<string, string> = {
    status: STATUS.starting,
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
    const timeStateTopic = `${BASE}/target_time/state`;
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
    this.pub(timeStateTopic, this.targetTimeOverride ?? this.config.targetTime);

    this.client.subscribe(timeCmdTopic, (err) => {
      if (err) log(`[MQTT status] subscribe error: ${err.message}`);
    });
    this.client.on("message", (topic: string, payload: Buffer) => {
      if (topic !== timeCmdTopic) return;
      const parts = payload.toString().trim().split(":");
      if (parts.length < 2) return;
      const newTime = `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
      this.targetTimeOverride = newTime;
      log(`[MQTT] Target time updated to ${newTime}`);
      this.pub(timeStateTopic, newTime);
      this.replanCallback?.();
    });

    log("MQTT discovery and initial state published.");
  }

  setStatus(status: string): void {
    if (status !== this.lastLoggedStatus) {
      if (status.startsWith("Charging until ")) {
        const charged = parseFloat(this.state.charged_energy) || 0;
        const remaining = Math.max(0, this.config.targetKwh - charged);
        log(
          `[Status] ${status} | ${charged.toFixed(2)} kWh charged, ${remaining.toFixed(2)} kWh remaining`,
        );
      } else if (status !== STATUS.chargingFinished) {
        log(`[Status] ${status}`);
      }
      this.lastLoggedStatus = status;
    }
    this.setState("status", status);
    if (status === STATUS.waitingForCar) {
      this.setState("plan_cost", "-");
      this.setState("solar_pct", "-");
      this.setState("charged_energy", "-");
    }
  }

  setAccumulatedCost(eur: number): void {
    this.accumulatedCostEur = eur;
  }

  setAccumulatedSolarPct(_pct: number): void {
    // stored by main-loop; no separate MQTT state needed beyond solar_pct from setPlan
  }

  setError(message: string): void {
    log(`[Status] ${message}`);
    this.setState("status", STATUS.error(message));
  }

  setPlan(slots: Slot[]): void {
    const charge = slots.filter((s) => s.charge);
    const cost = charge.reduce((sum, s) => sum + s.effectiveCostEur, 0);
    const totalSolarFraction = charge.reduce(
      (sum, s) => sum + Math.min(1, s.solarForecastW / 1000 / this.config.powerKw),
      0,
    );
    const pct = charge.length > 0 ? Math.round((totalSolarFraction / charge.length) * 100) : 0;
    this.setState("plan_cost", cost.toFixed(2));
    this.setState("solar_pct", String(pct));
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

export class LoggingPublisher implements Publisher {
  private config: EvChargingConfig;
  private targetTimeOverride: string | null = null;
  private replanCallback: (() => void) | null = null;
  private lastLoggedStatus = "";
  private chargedEnergyKwh = 0;
  private accumulatedCostEur = 0;

  constructor(config: EvChargingConfig) {
    this.config = config;
  }

  setReplanCallback(cb: () => void): void {
    this.replanCallback = cb;
  }

  getTargetTimeOverride(): string | null {
    return this.targetTimeOverride;
  }

  resetTargetTime(): void {
    this.targetTimeOverride = null;
    log(`[Publisher] Target time reset to ${this.config.targetTime}`);
  }

  setStatus(status: string): void {
    if (status !== this.lastLoggedStatus) {
      if (status.startsWith("Charging until ")) {
        const remaining = Math.max(0, this.config.targetKwh - this.chargedEnergyKwh);
        log(
          `[Status] ${status} | ${this.chargedEnergyKwh.toFixed(2)} kWh charged, ${remaining.toFixed(2)} kWh remaining`,
        );
      } else if (status !== STATUS.chargingFinished) {
        log(`[Status] ${status}`);
      }
      this.lastLoggedStatus = status;
    }
  }

  setAccumulatedCost(eur: number): void {
    this.accumulatedCostEur = eur;
  }

  setAccumulatedSolarPct(_pct: number): void {
    // value is logged by main-loop directly
  }

  setError(message: string): void {
    log(`[Error] ${message}`);
  }

  setPlan(slots: Slot[]): void {
    const charge = slots.filter((s) => s.charge);
    const cost = charge.reduce((sum, s) => sum + s.effectiveCostEur, 0);
    const totalSolarFraction = charge.reduce(
      (sum, s) => sum + Math.min(1, s.solarForecastW / 1000 / this.config.powerKw),
      0,
    );
    const pct = charge.length > 0 ? Math.round((totalSolarFraction / charge.length) * 100) : 0;
    log(`[Plan] Cost: \u20ac${cost.toFixed(2)}, Solar: ${pct}%`);
  }

  setChargedEnergy(kwh: number): void {
    this.chargedEnergyKwh = kwh;
  }
}

export function createPublisher(config: EvChargingConfig, client?: MqttClient): Publisher {
  if (client) return new StatusPublisher(client, config);
  return new LoggingPublisher(config);
}
