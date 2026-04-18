import type { MqttClient } from "./mqtt-client.ts";
import type { Slot } from "./types.ts";
import { log } from "./utils.ts";

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
  { id: "status",     name: "Status",                icon: "mdi:ev-station" },
  { id: "plan_cost",  name: "Estimated Charge Cost", icon: "mdi:currency-eur", unit: "€",  state_class: "measurement" },
  { id: "next_charge",name: "Next Charge Start",     icon: "mdi:clock-start" },
  { id: "solar_pct",  name: "Solar Power Share",     icon: "mdi:solar-power", unit: "%",  state_class: "measurement" },
];

function stateTopic(id: string) { return `${BASE}/${id}`; }
function discoveryTopic(id: string) { return `${DISCOVERY}/sensor/${DEVICE_ID}_${id}/config`; }

export class StatusPublisher {
  private client: MqttClient | null = null;

  private state: Record<string, string> = {
    status:     STATUS.starting,
    plan_cost:  "0.000",
    next_charge:"none",
    solar_pct:  "0",
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
    log("MQTT discovery and initial state published.");
  }

  setStatus(status: string): void {
    this.setState("status", status);
    if (status === STATUS.waitingForCar) {
      this.setState("plan_cost",  "0.000");
      this.setState("next_charge","none");
      this.setState("solar_pct",  "0");
    }
  }

  setError(message: string): void {
    this.setState("status", STATUS.error(message));
  }

  setPlan(slots: Slot[]): void {
    const charge = slots.filter(s => s.charge);
    const solar  = charge.filter(s => s.effectiveCostEur === 0);
    const cost   = charge.reduce((sum, s) => sum + s.effectiveCostEur, 0);
    const next   = charge[0];
    const pct    = charge.length > 0 ? Math.round(solar.length / charge.length * 100) : 0;
    this.setState("plan_cost",  cost.toFixed(3));
    this.setState("next_charge",next ? next.start.toISOString() : "none");
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
