import { loadConfig } from "../../src/config.ts";
import type { Config, EvChargingConfig, MqttConfig } from "../../src/config.ts";

/** Start of the main 17:00 session scenario used by all integration tests. */
export const FROM = new Date("2026-04-18T17:00:00");
export const SPEEDUP = 10_000;

export function makeTestConfig(
  chargingOverrides: Partial<EvChargingConfig["charging"]> = {},
  mqttOverrides: Partial<MqttConfig> = {},
): Config {
  const base = loadConfig();
  return {
    evCharging: {
      ...base.evCharging,
      mode: "charge" as const,
      charging: {
        ...base.evCharging.charging,
        targetKwh: 5,
        ...chargingOverrides,
        mqtt: {
          ...base.evCharging.charging.mqtt!,
          brokerUrl: "mqtt://localhost:1883",
          ...mqttOverrides,
        },
      },
    },
    solar: base.solar,
    electricity: base.electricity,
    test: { timeSpeedupFactor: SPEEDUP },
  };
}
