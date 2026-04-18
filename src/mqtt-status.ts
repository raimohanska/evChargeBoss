import type { MqttClient } from "./mqtt-client.ts";
import type { Slot } from "./types.ts";
import { log } from "./utils.ts";

export type AppStatus = "waiting_for_car" | "planning" | "charging" | "idle";

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
  { id: "status",            name: "Status",                icon: "mdi:ev-station" },
  { id: "charger_state",     name: "Charger State",         icon: "mdi:power-plug" },
  { id: "plan_charge_slots", name: "Charge Slots",          icon: "mdi:clock-outline", unit: "slots", state_class: "measurement" },
  { id: "plan_cost",         name: "Estimated Charge Cost", icon: "mdi:currency-eur",  unit: "€",     state_class: "measurement" },
  { id: "next_charge",       name: "Next Charge Start",     icon: "mdi:clock-start" },
];

function stateTopic(id: string) { return `${BASE}/${id}`; }
function discoveryTopic(id: string) { return `${DISCOVERY}/sensor/${DEVICE_ID}_${id}/config`; }

export class StatusPublisher {
  private client: MqttClient | null = null;

  // Tracks current values so they can be replayed on connect and kept consistent.
  private state: Record<string, string> = {
    status:            "starting",
    charger_state:     "OFF",
    plan_charge_slots: "0",
    plan_cost:         "0.000",
    next_charge:       "none",
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

  setError(message: string): void {
    this.setState("status", message);
  }

  setStatus(status: AppStatus): void {
    this.setState("status", status);
    if (status === "waiting_for_car") {
      // Clear stale plan data from the previous session.
      this.setState("plan_charge_slots", "0");
      this.setState("plan_cost", "0.000");
      this.setState("next_charge", "none");
      this.setState("charger_state", "OFF");
    }
  }

  setChargerState(on: boolean): void {
    this.setState("charger_state", on ? "ON" : "OFF");
  }

  setPlan(slots: Slot[]): void {
    const charge = slots.filter(s => s.charge);
    const cost = charge.reduce((sum, s) => sum + s.effectiveCostEur, 0);
    const next = charge[0];
    this.setState("plan_charge_slots", String(charge.length));
    this.setState("plan_cost", cost.toFixed(3));
    this.setState("next_charge", next ? next.start.toISOString() : "none");
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
