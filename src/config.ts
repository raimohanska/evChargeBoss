import { readFileSync, existsSync } from "fs";

export interface Config {
  mqtt: {
    brokerUrl: string;
    username: string;
    password: string;
    powerTopic: string;       // subscribe for power readings
    powerField: string;       // JSON key containing watts, e.g. {"power": 150}
    powerThresholdW: number;  // watts above which we consider a car plugged in
    chargerTopic: string;     // publish ON/OFF commands here
    onPayload: string;        // MQTT payload for ON  (e.g. '{"state":"ON"}')
    offPayload: string;       // MQTT payload for OFF (e.g. '{"state":"OFF"}')
  };
  charging: {
    targetKwh: number;   // energy needed per session
    powerKw: number;     // charger power
    targetTime: string;  // next-day deadline (local time, "HH:MM")
  };
  solar: {
    lat: number;
    lon: number;
    declination: number;  // roof pitch in degrees
    azimuth: number;      // 0=south, -90=east, 90=west
    kwp: number;          // installed kWp
    efficiencyFactor: number;
    treeShadingSchedule: Array<{ time: string; outputFraction: number }>;
  };
  electricity: {
    transportCostEurKwh: number;  // transfer tariff + taxes, €/kWh
  };
}

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

export const CONFIG: Config = JSON.parse(readFileSync(getConfigPath(), "utf8")) as Config;
