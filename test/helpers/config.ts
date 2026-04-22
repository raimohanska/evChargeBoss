import { loadConfig } from "../../src/config.ts";
import type { Config, MqttConfig } from "../../src/config.ts";

/** Start of the main 17:00 session scenario used by all integration tests. */
export const FROM = new Date("2026-04-18T17:00:00");
export const SPEEDUP = 10_000;

export function makeTestConfig(
  chargingOverrides: Partial<Omit<Config["evCharging"], "mode" | "mqtt">> = {},
  mqttOverrides: Partial<MqttConfig> = {},
): Config {
  const base = loadConfig();
  return {
    mqtt: { ...base.mqtt!, brokerUrl: "mqtt://localhost:1883" },
    evCharging: {
      ...base.evCharging,
      mode: "charge" as const,
      targetKwh: 5,
      ...chargingOverrides,
      mqtt: {
        ...base.evCharging.mqtt!,
        ...mqttOverrides,
      },
    },
    solar: base.solar,
    electricity: base.electricity,
    test: { timeSpeedupFactor: SPEEDUP },
  };
}
