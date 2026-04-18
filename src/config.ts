import { readFileSync, existsSync } from "fs";
import { z } from "zod";

const ModeSchema = z.enum(["charge", "plan", "simulate"]);

const ConfigSchema = z.strictObject({
  mode: ModeSchema,
  mqtt: z.strictObject({
    brokerUrl: z.string(),
    username: z.string(),
    password: z.string(),
    powerTopic: z.string(),
    powerField: z.string(),
    powerThresholdW: z.number(),
    chargerTopic: z.string(),
    onPayload: z.string(),
    offPayload: z.string(),
  }).optional(),
  charging: z.strictObject({
    targetKwh: z.number().positive(),
    powerKw: z.number().positive(),
    targetTime: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
  }),
  solar: z.strictObject({
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
    declination: z.number(),
    azimuth: z.number(),
    kwp: z.number().positive(),
    treeShadingSchedule: z.array(z.strictObject({
      time: z.string().regex(/^\d{2}:\d{2}$/, 'must be "HH:MM"'),
      outputFraction: z.number().min(0).max(1),
    })),
  }),
  electricity: z.strictObject({
    transportCostEurKwh: z.number().nonnegative(),
  }),
});

export type Mode = z.infer<typeof ModeSchema>;
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
    "\n   and edit it to configure your system before running for real.\n"
  );
  return "config-example.json";
}

function loadConfig(): Config {
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

export const CONFIG: Config = loadConfig();
