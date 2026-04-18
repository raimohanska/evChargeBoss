import type { Slot } from "./config.ts";
import { log, sleep } from "./utils.ts";

export interface ChargerDriver {
  send(on: boolean): Promise<void>;
}

export const simulateDriver: ChargerDriver = {
  async send(on: boolean) {
    log(`[SIMULATE] → ${on ? "ON " : "OFF"}`);
  },
};

// TODO: replace stub with real MQTT once broker config is added to CONFIG
export const mqttDriver: ChargerDriver = {
  async send(on: boolean) {
    log(`[MQTT] → ${on ? "ON " : "OFF"}  (not yet implemented — add mqtt config)`);
  },
};

export async function runCharging(slots: Slot[], driver: ChargerDriver): Promise<void> {
  const now = new Date();
  const upcoming = slots.filter((s) => s.end > now);

  for (const slot of upcoming) {
    const msUntilStart = slot.start.getTime() - Date.now();
    if (msUntilStart > 0) {
      log(`Waiting ${Math.round(msUntilStart / 1000)}s until slot ${slot.start.toLocaleTimeString()}`);
      await sleep(msUntilStart);
    }

    const label = slot.charge
      ? slot.effectiveCostEur === 0 ? "solar-free" : `${slot.effectiveCostEur.toFixed(3)} €`
      : "too expensive";
    log(`[${slot.charge ? "ON " : "OFF"}] ${slot.start.toLocaleTimeString()}–${slot.end.toLocaleTimeString()} | ${label}`);
    await driver.send(slot.charge);

    const msUntilEnd = slot.end.getTime() - Date.now();
    if (msUntilEnd > 0) await sleep(msUntilEnd);
  }

  log("Charging session complete.");
}
