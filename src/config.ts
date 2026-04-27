import { readFileSync, existsSync } from "fs";
import { z } from "zod";
import { EvChargingConfig } from "./ev-charging/config.ts";
import { ElectricityConfig, SolarConfig } from "./electricity/config.ts";

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
  test: TestConfig,
});

export type Config = z.infer<typeof Config>;

function getConfigPath(): string {
  if (process.env.CONFIG_FILE) return process.env.CONFIG_FILE;
  const idx = process.argv.indexOf("--config");
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (existsSync("config.json")) return "config.json";
  const tty = process.stdout.isTTY === true;
  console.warn(
    `\n${tty ? "\u26a0\ufe0f  WARNING:" : "WARNING:"} config.json not found` +
      ` ${tty ? "\u2014" : "-"} falling back to config-example.json.` +
      "\n   This uses placeholder values. Copy config-example.json to config.json" +
      "\n   and edit it to configure your system before running for real.\n",
  );
  return "config-example.json";
}

export function loadConfig(): Config {
  const path = getConfigPath();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`ERROR: Failed to read config file "${path}": ${msg}`);
    process.exit(1);
  }

  const result = Config.safeParse(raw);
  if (result.success) return result.data;

  console.error(`ERROR: Invalid config file "${path}":\n`);
  for (const issue of result.error.issues) {
    const field = issue.path.join(".");
    console.error(`  ${field ? field + ": " : ""}${issue.message}`);
  }
  console.error();
  process.exit(1);
}
