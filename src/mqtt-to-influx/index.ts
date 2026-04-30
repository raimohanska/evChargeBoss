import type { Config } from "../config.ts";
import type { SensorConfig } from "./config.ts";
import { connectMqtt } from "../ev-charging/mqtt-client.ts";
import { writeLine, escapeTagKeyValue } from "../influx.ts";
import type { InfluxConfig } from "../influx.ts";
import { log } from "../utils/log.ts";

export function parseValue(payload: string, sensor: SensorConfig): number | null {
  let raw: unknown;

  if (sensor.json_field) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      raw = parsed[sensor.json_field];
    } catch {
      return null;
    }
  } else {
    const trimmed = payload.trim();
    if (trimmed === "true" || trimmed === "ON") raw = true;
    else if (trimmed === "false" || trimmed === "OFF") raw = false;
    else {
      const n = parseFloat(trimmed);
      if (isNaN(n) || !isFinite(n)) return null;
      raw = n;
    }
  }

  let value: number;
  if (typeof raw === "boolean") {
    value = raw ? 1 : 0;
  } else if (typeof raw === "number") {
    if (!isFinite(raw)) return null;
    value = raw;
  } else if (typeof raw === "string") {
    if (raw === "true" || raw === "ON") value = 1;
    else if (raw === "false" || raw === "OFF") value = 0;
    else {
      const n = parseFloat(raw);
      if (isNaN(n) || !isFinite(n)) return null;
      value = n;
    }
  } else {
    return null;
  }

  // Motion values are always 0 or 1
  if (sensor.type === "motion") {
    value = value !== 0 ? 1 : 0;
  }

  return value;
}

export function formatSensorLine(sensor: SensorConfig, value: number, timestampMs: number): string {
  const tagEntries: [string, string][] = [
    ["name", sensor.name],
    ["device", sensor.device],
    ["location", sensor.location],
    ["unit", sensor.unit],
  ];
  const tags = tagEntries
    .filter(([, v]) => v !== "")
    .map(([k, v]) => `${escapeTagKeyValue(k)}=${escapeTagKeyValue(v)}`);
  return `${escapeTagKeyValue(sensor.type)},${tags.join(",")} value=${value} ${timestampMs}`;
}

async function handleMessage(
  topic: string,
  payload: string,
  topicMap: Map<string, SensorConfig[]>,
  influxConfig: InfluxConfig,
): Promise<void> {
  const sensors = topicMap.get(topic);
  if (!sensors) return;

  const now = Date.now();
  for (const sensor of sensors) {
    const value = parseValue(payload, sensor);
    if (value === null) {
      log(`[MqttToInflux] Could not parse value from ${topic}: ${payload.slice(0, 80)}`);
      continue;
    }
    const line = formatSensorLine(sensor, value, now);
    try {
      await writeLine(influxConfig, line);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[MqttToInflux] ERROR writing ${sensor.name}: ${msg} — line: ${line}`);
    }
  }
}

export async function runMqttToInflux(config: Config): Promise<void> {
  if (!config.mqttToInflux) return;

  if (!config.influx) {
    log("[MqttToInflux] WARNING: influx not configured — mqtt-to-influx disabled");
    return;
  }

  if (!config.mqtt) {
    console.error("ERROR: mqtt-to-influx requires mqtt broker configured in config.json");
    process.exit(1);
  }

  log("[MqttToInflux] Starting...");

  const client = await connectMqtt(config.mqtt);
  const { sensors } = config.mqttToInflux;
  const influxConfig = config.influx;

  const topicMap = new Map<string, SensorConfig[]>();
  for (const sensor of sensors) {
    const existing = topicMap.get(sensor.mqtt_topic) ?? [];
    existing.push(sensor);
    topicMap.set(sensor.mqtt_topic, existing);
  }

  for (const topic of topicMap.keys()) {
    client.subscribe(topic, (err) => {
      if (err) log(`[MqttToInflux] Subscribe error for ${topic}: ${err.message}`);
    });
  }

  client.on("message", (topic: string, message: Buffer) => {
    handleMessage(topic, message.toString(), topicMap, influxConfig).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[MqttToInflux] Unexpected error: ${msg}`);
    });
  });

  log(`[MqttToInflux] Subscribed to ${topicMap.size} topic(s).`);

  // Keep alive — the MQTT client drives all activity via event listeners
  return new Promise(() => {});
}
