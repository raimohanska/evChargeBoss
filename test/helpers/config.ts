import { loadConfig } from "../../src/config.ts";
import type { Config } from "../../src/config.ts";

export const FROM = new Date("2026-04-18T17:00:00");
export const SPEEDUP = 10_000;

export function makeTestConfig(): Config {
  const base = loadConfig();
  return {
    ...base,
    mode: "charge" as const,
    mqtt: { ...base.mqtt!, brokerUrl: "mqtt://localhost:1883" },
    charging: { ...base.charging, targetKwh: 5 },
    test: { timeSpeedupFactor: SPEEDUP, justOnce: true },
  };
}
