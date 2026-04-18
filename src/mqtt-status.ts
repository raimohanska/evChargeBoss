import type { MqttClient } from "./mqtt-client.ts";
import { CONFIG } from "./config.ts";
import type { Slot } from "./types.ts";
import { localTimeShort, log } from "./utils.ts";

let targetTimeOverride: string | null = null;

/** Returns the active target charge time (HA override if set, otherwise config). */
export function getTargetTime(): string {
  return targetTimeOverride ?? CONFIG.charging.targetTime;
}

// All possible status values. Static states are plain strings; dynamic ones are functions.
export const STATUS = {
  starting:           "Starting...",
  waitingForCar:      "Waiting for car to be plugged in",
  fetchingData:       "Fetching data...",
  waitingForSpot:     "Waiting for spot prices",
  waitingForSolar:    "Waiting for solar forecast",
  mqttError:          "MQTT connection error",
  idle:               "Idle",
  plannedChargeStart: (time: string) => `Planned charge start at ${time}`,
  charging:           (until: string) => `Charging until ${until}`,
  error:              (msg: string) => msg,
} as const;

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
  { id: "status",     name: "Status",                  icon: "mdi:ev-station" },
  { id: "plan_cost",  name: "Estimated Charge Cost (€)",icon: "mdi:currency-eur" },
  { id: "next_charge",name: "Next Charge Start",        icon: "mdi:clock-start" },
  { id: "solar_pct",  name: "Solar Power Share (%)",    icon: "mdi:solar-power" },
];

function stateTopic(id: string) { return `${BASE}/${id}`; }
function discoveryTopic(id: string) { return `${DISCOVERY}/sensor/${DEVICE_ID}_${id}/config`; }

export class StatusPublisher {
  private client: MqttClient | null = null;
  private replanCallback: (() => void) | null = null;

  setReplanCallback(cb: () => void): void {
    this.replanCallback = cb;
  }

  private state: Record<string, string> = {
    status:     STATUS.starting,
    plan_cost:  "-",
    next_charge:"-",
    solar_pct:  "-",
  };

  setClient(client: MqttClient): void {
    this.client = client;
    for (const s of SENSORS) {
      const config: Record<string, unknown> = {
        unique_id: `${DEVICE_ID}_${s.id}`,
        name: s.name,
        state_topic: stateTopic(s.id),
        icon: s.icon,
        device: DEVICE,
        ...(s.unit        && { unit_of_measurement: s.unit }),
        ...(s.state_class && { state_class: s.state_class }),
      };
      this.pub(discoveryTopic(s.id), JSON.stringify(config), true);
    }
    for (const s of SENSORS) {
      this.pub(stateTopic(s.id), this.state[s.id]);
    }

    // HA text entity for target charge time (HH:MM input with pattern validation)
    const timeCmdTopic   = `${BASE}/target_time/set`;
    const timeStateTopic = `${BASE}/target_time/state`;
    const timeDiscoveryTopic = `${DISCOVERY}/text/${DEVICE_ID}_target_time/config`;
    const timeDiscoveryPayload = JSON.stringify({
      unique_id:     `${DEVICE_ID}_target_time`,
      name:          "Charge Target Time",
      icon:          "mdi:clock-end",
      state_topic:   timeStateTopic,
      command_topic: timeCmdTopic,
      pattern:       "^([01]?[0-9]|2[0-3]):[0-5][0-9]$",
      device:        DEVICE,
    });
    // Remove any previously-retained `time` discovery (old entity type, now replaced by `text`)
    this.pub(`${DISCOVERY}/time/${DEVICE_ID}_target_time/config`, "", true);
    this.pub(timeDiscoveryTopic, timeDiscoveryPayload, true);
    this.pub(timeStateTopic, getTargetTime());

    client.subscribe(timeCmdTopic, (err) => {
      if (err) log(`[MQTT status] subscribe error: ${err.message}`);
    });
    client.on("message", (topic: string, payload: Buffer) => {
      if (topic !== timeCmdTopic) return;
      const parts = payload.toString().trim().split(":");
      if (parts.length < 2) return;
      const newTime = `${parts[0].padStart(2, "0")}:${parts[1].padStart(2, "0")}`;
      targetTimeOverride = newTime;
      log(`[MQTT] Target time updated to ${newTime}`);
      this.pub(timeStateTopic, newTime);
      this.replanCallback?.();
    });

    log("MQTT discovery and initial state published.");
  }

  setStatus(status: string): void {
    this.setState("status", status);
    if (status === STATUS.waitingForCar) {
      this.setState("plan_cost",  "-");
      this.setState("next_charge","-");
      this.setState("solar_pct",  "-");
    }
  }

  setError(message: string): void {
    this.setState("status", STATUS.error(message));
  }

  setPlan(slots: Slot[]): void {
    const charge = slots.filter(s => s.charge);
    const cost   = charge.reduce((sum, s) => sum + s.effectiveCostEur, 0);
    const next   = charge[0];
    const totalSolarFraction = charge.reduce(
      (sum, s) => sum + Math.min(1, s.solarForecastW / 1000 / CONFIG.charging.powerKw), 0);
    const pct = charge.length > 0 ? Math.round(totalSolarFraction / charge.length * 100) : 0;
    this.setState("plan_cost",  cost.toFixed(3));
    this.setState("next_charge",next ? localTimeShort(next.start) : "-");
    this.setState("solar_pct",  String(pct));
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
