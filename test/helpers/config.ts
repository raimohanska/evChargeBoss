import { loadConfig } from "../../src/config.ts";
import type { Config, MqttConfig } from "../../src/config.ts";

/** Start of the main 17:00 session scenario used by all integration tests. */
export const FROM = new Date("2026-04-18T17:00:00");

/**
 * Virtual-time speedup for integration tests. 10_000 was too aggressive: at
 * 10k the ~40ms real latency of each cross-client MQTT hop (Nagle + delayed
 * ACK on the mosquitto accepted socket inside the devcontainer) becomes
 * ~6.7 virtual minutes, so an OFF sent at 17:00 arrived after the 17:10
 * assertion. 4_000 keeps the OFF budget (600 virtual min) comfortably inside
 * the real window while the ~17h overnight gap still elapses in ~15s.
 */
export const SPEEDUP = 4_000;

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
