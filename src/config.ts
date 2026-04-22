import { readFileSync, existsSync } from "fs";
import { z } from "zod";
import { EvChargingConfigSchema } from "./ev-charging/config.ts";

export type { Mode, EvChargingConfig, MqttConfig, ChargingConfig } from "./ev-charging/config.ts";

const SolarConfigSchema = z.strictObject({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  declination: z.number(),
  azimuth: z.number(),
  kwp: z.number().positive(),
  treeShadingSchedule: z.array(
    z.strictObject({
      time: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
      outputFraction: z.number().min(0).max(1),
    }),
  ),
});

const ElectricityConfigSchema = z.strictObject({
  transportCostEurKwh: z.number().nonnegative(),
});

const TestConfigSchema = z
  .object({
    timeSpeedupFactor: z.number().positive().optional(),
  })
  .optional();

export type SolarConfig = z.infer<typeof SolarConfigSchema>;
export type ElectricityConfig = z.infer<typeof ElectricityConfigSchema>;

const ConfigSchema = z.strictObject({
  evCharging: EvChargingConfigSchema,
  solar: SolarConfigSchema,
  electricity: ElectricityConfigSchema,
  test: TestConfigSchema,
});

export type Config = z.infer<typeof ConfigSchema>;

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

  const result = ConfigSchema.safeParse(raw);
  if (result.success) return result.data;

  console.error(`ERROR: Invalid config file "${path}":\n`);
  for (const issue of result.error.issues) {
    const field = issue.path.join(".");
    console.error(`  ${field ? field + ": " : ""}${issue.message}`);
  }
  console.error();
  process.exit(1);
}
