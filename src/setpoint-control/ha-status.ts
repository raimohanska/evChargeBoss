import type { MqttClient } from "../ev-charging/mqtt-client.ts";
import type { Config } from "../config.ts";
import type { SetpointControlConfig } from "./config.ts";
import type { CostTier } from "./types.ts";
import { writeConfigAtomically } from "../config.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("setpoint-control");

const DISCOVERY = "homeassistant";
const BASE = "evchargeboss";

// ─── Entity definitions ────────────────────────────────────────────────────

interface NumberDef {
  field: string;
  name: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  icon: string;
  description: string;
  /** Reads the current value from spConfig. */
  get: (sp: SetpointControlConfig) => number | undefined;
  /** Writes a validated new value into spConfig. */
  set: (sp: SetpointControlConfig, v: number) => void;
}

const NUMBER_DEFS: NumberDef[] = [
  {
    field: "setpointDefault",
    name: "Default Setpoint (average-cost slots)",
    min: 0,
    max: 100,
    step: 0.1,
    icon: "mdi:thermometer",
    description:
      "The setpoint value sent to the device during slots with average electricity cost. " +
      "This is the baseline operating level when prices are neither cheap nor expensive.",
    get: (sp) => sp.setpointDefault,
    set: (sp, v) => {
      sp.setpointDefault = v;
    },
  },
  {
    field: "setpointCheap",
    name: "Cheap Slot Setpoint (cheapest N slots per day)",
    min: 0,
    max: 100,
    step: 0.1,
    icon: "mdi:thermometer-chevron-up",
    description:
      "The setpoint sent during the cheapest slots of the day. " +
      "The number of cheap slots equals the number of slots classified as expensive, " +
      "so the device compensates for expensive periods by heating/cooling more when electricity is cheap.",
    get: (sp) => sp.setpointCheap,
    set: (sp, v) => {
      sp.setpointCheap = v;
    },
  },
  {
    field: "setpointExpensive",
    name: "Expensive Slot Setpoint (high-cost slots)",
    min: 0,
    max: 100,
    step: 0.1,
    icon: "mdi:thermometer-chevron-down",
    description:
      "The setpoint sent during expensive slots. " +
      "A slot is expensive when its cost exceeds the daily average multiplied by the Expensive Price Factor. " +
      "If not set, the device keeps its current setpoint during expensive slots.",
    get: (sp) => sp.setpointExpensive,
    set: (sp, v) => {
      sp.setpointExpensive = v;
    },
  },
  {
    field: "expensiveFactor",
    name: "Expensive Price Factor (×avg daily cost)",
    min: 1.0,
    max: 10.0,
    step: 0.1,
    icon: "mdi:currency-eur",
    description:
      "Multiplier applied to the daily average slot cost to decide whether a slot is expensive. " +
      "E.g. 1.5 means a slot must cost at least 50% more than average to be treated as expensive. " +
      "Higher values → fewer slots are considered expensive.",
    get: (sp) => sp.expensiveFactor,
    set: (sp, v) => {
      sp.expensiveFactor = v;
    },
  },
  {
    field: "defaultPowerConsumptionW",
    name: "Power Consumption (W, device wattage)",
    min: 100,
    max: 10000,
    step: 100,
    unit: "W",
    icon: "mdi:lightning-bolt",
    description:
      "The rated power draw of the device in watts. " +
      "Used together with the solar forecast to compute the net electricity cost of each 15-minute slot. " +
      "Set this to the device's typical or rated wattage.",
    get: (sp) => sp.defaultPowerConsumptionW,
    set: (sp, v) => {
      sp.defaultPowerConsumptionW = v;
    },
  },
  {
    field: "setpointMin",
    name: "Minimum Setpoint (lower clamp)",
    min: 0,
    max: 100,
    step: 0.1,
    icon: "mdi:thermometer-low",
    description:
      "The published setpoint will never fall below this value, regardless of price tier or room-temperature adjustments. " +
      "Useful to ensure the device never goes below a safe minimum (e.g. anti-frost).",
    get: (sp) => sp.setpointMin,
    set: (sp, v) => {
      sp.setpointMin = v;
    },
  },
  {
    field: "setpointMax",
    name: "Maximum Setpoint (upper clamp)",
    min: 0,
    max: 100,
    step: 0.1,
    icon: "mdi:thermometer-high",
    description:
      "The published setpoint will never exceed this value, regardless of price tier or room-temperature adjustments. " +
      "Useful to protect the device or connected plumbing from overheating.",
    get: (sp) => sp.setpointMax,
    set: (sp, v) => {
      sp.setpointMax = v;
    },
  },
  // Room temperature sub-fields — only published when roomTemperature block is present
  {
    field: "roomTemp_target",
    name: "Room Target Temperature",
    min: 5,
    max: 35,
    step: 0.5,
    unit: "°C",
    icon: "mdi:home-thermometer",
    description:
      "The desired room air temperature in °C. " +
      "When the measured room temperature deviates from this target by more than the allowed deviation, " +
      "the planned setpoint is adjusted up or down by the Room Temp Influence amount.",
    get: (sp) => sp.roomTemperature?.targetTemperature,
    set: (sp, v) => {
      if (sp.roomTemperature) sp.roomTemperature.targetTemperature = v;
    },
  },
  {
    field: "roomTemp_deviationUp",
    name: "Room Temp Deviation Up (°C above target)",
    min: 0,
    max: 10,
    step: 0.5,
    unit: "°C",
    icon: "mdi:thermometer-plus",
    description:
      "How many °C above the target temperature the room may be before the setpoint is lowered. " +
      "E.g. 1.0 means the setpoint is reduced when the room is warmer than target + 1°C.",
    get: (sp) => sp.roomTemperature?.allowedDeviationUp,
    set: (sp, v) => {
      if (sp.roomTemperature) sp.roomTemperature.allowedDeviationUp = v;
    },
  },
  {
    field: "roomTemp_deviationDown",
    name: "Room Temp Deviation Down (°C below target)",
    min: 0,
    max: 10,
    step: 0.5,
    unit: "°C",
    icon: "mdi:thermometer-minus",
    description:
      "How many °C below the target temperature the room may be before the setpoint is raised. " +
      "E.g. 1.0 means the setpoint is increased when the room is colder than target − 1°C.",
    get: (sp) => sp.roomTemperature?.allowedDeviationDown,
    set: (sp, v) => {
      if (sp.roomTemperature) sp.roomTemperature.allowedDeviationDown = v;
    },
  },
  {
    field: "roomTemp_influence",
    name: "Room Temp Influence (setpoint delta, °C)",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "°C",
    icon: "mdi:plus-minus",
    description:
      "How many °C the setpoint is adjusted when the room is outside the allowed temperature range. " +
      "E.g. 2.0 means the setpoint is raised by 2°C when the room is too cold, or lowered by 2°C when too warm.",
    get: (sp) => sp.roomTemperature?.influence,
    set: (sp, v) => {
      if (sp.roomTemperature) sp.roomTemperature.influence = v;
    },
  },
];

// ─── Publisher ────────────────────────────────────────────────────────────────

export class SetpointStatusPublisher {
  private readonly client: MqttClient;
  private readonly id: string;
  private readonly spConfig: SetpointControlConfig;
  private readonly fullConfig: Config;
  private readonly configPath: string;
  private readonly deviceId: string;
  private readonly base: string;

  constructor(
    client: MqttClient,
    id: string,
    spConfig: SetpointControlConfig,
    fullConfig: Config,
    configPath: string,
  ) {
    this.client = client;
    this.id = id;
    this.spConfig = spConfig;
    this.fullConfig = fullConfig;
    this.configPath = configPath;
    this.deviceId = `evchargeboss_setpoint_${id}`;
    this.base = `${BASE}/setpoint/${id}`;
  }

  // ─── Topic helpers ───────────────────────────────────────────────────────

  private stateTopic(field: string): string {
    return `${this.base}/${field}`;
  }

  private cmdTopic(field: string): string {
    return `${this.base}/${field}/set`;
  }

  private attrTopic(field: string): string {
    return `${this.base}/${field}/attr`;
  }

  private discoveryTopic(type: string, field: string): string {
    return `${DISCOVERY}/${type}/${this.deviceId}_${field}/config`;
  }

  // ─── Device object ───────────────────────────────────────────────────────

  private get device(): Record<string, unknown> {
    return {
      identifiers: [this.deviceId],
      name: this.spConfig.name,
    };
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  isEnabled(): boolean {
    return this.spConfig.enabled !== false;
  }

  setStatus(text: string): void {
    this.pub(this.stateTopic("status"), text);
  }

  setCurrentSlot(
    tier: CostTier,
    plannedSetpoint: number,
    actualSetpoint: number,
    until: string,
  ): void {
    const tierLabel = tier === "cheap" ? "cheap" : tier === "expensive" ? "expensive" : "normal";
    const delta = Math.round((actualSetpoint - plannedSetpoint) * 10) / 10;
    const adjustment =
      delta !== 0 ? ` (planned ${plannedSetpoint}, ${delta > 0 ? "+" : ""}${delta} room temp)` : "";
    this.setStatus(
      `Current slot: ${tierLabel} - setpoint ${actualSetpoint}${adjustment} (until ${until})`,
    );
  }

  // ─── Discovery initialisation ─────────────────────────────────────────────

  initDiscovery(): void {
    // Status sensor
    this.pubRetain(
      this.discoveryTopic("sensor", "status"),
      JSON.stringify({
        unique_id: `${this.deviceId}_status`,
        name: "Status",
        state_topic: this.stateTopic("status"),
        icon: "mdi:information-outline",
        device: this.device,
      }),
    );
    this.pubRetain(this.stateTopic("status"), this.isEnabled() ? "Starting..." : "Disabled");

    // Enable/disable switch
    const switchCmdTopic = this.cmdTopic("enabled");
    const switchStateTopic = this.stateTopic("enabled");
    this.pubRetain(
      this.discoveryTopic("switch", "enabled"),
      JSON.stringify({
        unique_id: `${this.deviceId}_enabled`,
        name: "Automation",
        state_topic: switchStateTopic,
        command_topic: switchCmdTopic,
        payload_on: "ON",
        payload_off: "OFF",
        icon: "mdi:auto-mode",
        device: this.device,
      }),
    );
    this.pubRetain(switchStateTopic, this.isEnabled() ? "ON" : "OFF");
    this.pubRetain(
      this.attrTopic("enabled"),
      JSON.stringify({
        description:
          "When ON, the automation publishes setpoint commands every 15 minutes based on electricity prices and solar forecast. " +
          "When OFF, no commands are sent, allowing manual control of the device setpoint via other means.",
      }),
    );

    // Number entities
    for (const def of NUMBER_DEFS) {
      const value = def.get(this.spConfig);
      // Skip optional fields not present in config
      if (value === undefined) continue;

      const stateTopic = this.stateTopic(def.field);
      const cmdTopic = this.cmdTopic(def.field);
      const attrTopic = this.attrTopic(def.field);

      const payload: Record<string, unknown> = {
        unique_id: `${this.deviceId}_${def.field}`,
        name: def.name,
        state_topic: stateTopic,
        command_topic: cmdTopic,
        json_attributes_topic: attrTopic,
        min: def.min,
        max: def.max,
        step: def.step,
        icon: def.icon,
        device: this.device,
      };
      if (def.unit) payload.unit_of_measurement = def.unit;

      this.pubRetain(this.discoveryTopic("number", def.field), JSON.stringify(payload));
      this.pubRetain(stateTopic, String(value));
      this.pubRetain(attrTopic, JSON.stringify({ description: def.description }));
    }

    // Subscribe to all command topics
    const cmdTopics = [
      this.cmdTopic("enabled"),
      ...NUMBER_DEFS.filter((d) => d.get(this.spConfig) !== undefined).map((d) =>
        this.cmdTopic(d.field),
      ),
    ];
    for (const topic of cmdTopics) {
      this.client.subscribe(topic, (err) => {
        if (err) log(`[${this.spConfig.name}] subscribe error on ${topic}: ${err.message}`);
      });
    }

    this.client.on("message", (topic: string, payload: Buffer) => {
      this.handleMessage(topic, payload.toString().trim());
    });

    log(`[${this.spConfig.name}] HA MQTT discovery published.`);
  }

  // ─── Message handler ─────────────────────────────────────────────────────

  private handleMessage(topic: string, payload: string): void {
    if (topic === this.cmdTopic("enabled")) {
      this.handleSwitch(payload);
      return;
    }
    for (const def of NUMBER_DEFS) {
      if (topic === this.cmdTopic(def.field)) {
        this.handleNumber(def, payload);
        return;
      }
    }
  }

  private handleSwitch(payload: string): void {
    if (payload !== "ON" && payload !== "OFF") return;
    const enabled = payload === "ON";
    this.spConfig.enabled = enabled;
    log(`[${this.spConfig.name}] Automation ${enabled ? "enabled" : "disabled"} via HA.`);
    this.pubRetain(this.stateTopic("enabled"), payload);
    this.persistConfig();
  }

  private handleNumber(def: NumberDef, payload: string): void {
    const value = parseFloat(payload);
    if (isNaN(value)) {
      log(`[${this.spConfig.name}] Ignoring non-numeric value for ${def.field}: ${payload}`);
      return;
    }
    const clamped = Math.min(def.max, Math.max(def.min, value));
    def.set(this.spConfig, clamped);
    log(`[${this.spConfig.name}] ${def.field} updated to ${clamped} via HA.`);
    this.pubRetain(this.stateTopic(def.field), String(clamped));
    this.persistConfig();
  }

  // ─── Config persistence ──────────────────────────────────────────────────

  private persistConfig(): void {
    try {
      writeConfigAtomically(this.configPath, this.fullConfig);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[${this.spConfig.name}] ERROR: failed to write config: ${msg}`);
    }
  }

  // ─── MQTT helpers ─────────────────────────────────────────────────────────

  private pubRetain(topic: string, payload: string): void {
    this.client.publish(topic, payload, { retain: true }, (err) => {
      if (err) log(`[${this.spConfig.name}] publish error on ${topic}: ${err.message}`);
    });
  }

  private pub(topic: string, payload: string): void {
    this.client.publish(topic, payload, { retain: true }, (err) => {
      if (err) log(`[${this.spConfig.name}] publish error on ${topic}: ${err.message}`);
    });
  }
}
