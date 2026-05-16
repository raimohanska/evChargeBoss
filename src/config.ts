import { readFileSync, writeFileSync, renameSync, existsSync } from "fs";
import { z } from "zod";
import { EvChargingConfig } from "./ev-charging/config.ts";
import { ElectricityConfig, SolarConfig } from "./electricity/config.ts";
import { SetpointControlConfig } from "./setpoint-control/config.ts";
import { MqttToInfluxConfig } from "./mqtt-to-influx/config.ts";

// Stderr logger for startup-time config errors (no date prefix needed — these
// happen before the main loop starts and process.exit follows shortly after).
const configError = (msg: string) =>
  msg.split("\n").forEach((line) => console.error(`[config] ${line}`));
const configWarn = (msg: string) =>
  msg.split("\n").forEach((line) => console.error(`[config] ${line}`));

const InfluxConfig = z.strictObject({
  url: z.string(),
  token: z.string(),
  org: z.string(),
  bucket: z.string(),
  tags: z.record(z.string(), z.string()).optional(),
});
export type InfluxConfig = z.infer<typeof InfluxConfig>;

export type {
  Mode,
  EvChargingConfig,
  EvChargingMqttConfig as MqttConfig,
} from "./ev-charging/config.ts";

const BrokerConfig = z.strictObject({
  brokerUrl: z.string(),
  username: z.string(),
  password: z.string(),
});

export type BrokerConfig = z.infer<typeof BrokerConfig>;

const TestConfig = z
  .object({
    timeSpeedupFactor: z.number().positive().optional(),
  })
  .optional();

const Config = z.strictObject({
  mqtt: BrokerConfig.optional(),
  evCharging: EvChargingConfig,
  solar: SolarConfig,
  electricity: ElectricityConfig,
  influx: InfluxConfig.optional(),
  setpointControl: z.record(z.string(), SetpointControlConfig).optional(),
  mqttToInflux: MqttToInfluxConfig.optional(),
  test: TestConfig,
});

export type Config = z.infer<typeof Config>;

export function getConfigPath(): string {
  if (process.env.CONFIG_FILE) return process.env.CONFIG_FILE;
  const idx = process.argv.indexOf("--config");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (existsSync("config.json")) return "config.json";
  const tty = process.stdout.isTTY === true;
  configWarn(
    `${tty ? "\u26a0\ufe0f  WARNING:" : "WARNING:"} config.json not found` +
      ` ${tty ? "\u2014" : "-"} falling back to config-example.json.` +
      "\n   This uses placeholder values. Copy config-example.json to config.json" +
      "\n   and edit it to configure your system before running for real.",
  );
  return "config-example.json";
}

/**
 * Atomically writes config to disk by writing to a tmp file then renaming.
 * If the path resolves to config-example.json, the write is skipped.
 */
export function writeConfigAtomically(configPath: string, config: Config): void {
  if (configPath.endsWith("config-example.json")) {
    configWarn("Refusing to overwrite config-example.json - changes not persisted.");
    return;
  }
  const tmp = `${configPath}.tmp`;
  writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", "utf8");
  renameSync(tmp, configPath);
}

export function loadConfig(): Config {
  const path = getConfigPath();
  let raw: unknown;
  let source: string;
  try {
    source = readFileSync(path, "utf8");
    raw = JSON.parse(source);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // Enrich SyntaxErrors with line:col by extracting the position from the
    // error message and counting newlines in the source up to that point.
    const posMatch = msg.match(/position (\d+)/);
    if (posMatch && source!) {
      const pos = parseInt(posMatch[1], 10);
      const before = source.slice(0, pos);
      const line = before.split("\n").length;
      const col = pos - before.lastIndexOf("\n");
      configError(`ERROR: Invalid JSON in "${path}" at line ${line}, column ${col}: ${msg}`);
    } else {
      configError(`ERROR: Failed to read config file "${path}": ${msg}`);
    }
    process.exit(1);
  }

  const result = Config.safeParse(raw);
  if (result.success) return result.data;

  configError(`ERROR: Invalid config file "${path}":`);
  for (const issue of result.error.issues) {
    const field = issue.path.join(".");
    configError(`  ${field ? field + ": " : ""}${issue.message}`);
  }
  configError("");
  process.exit(1);
}
