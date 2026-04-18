import type { Slot } from "./config.ts";
import { log, sleep } from "./utils.ts";

export interface ChargerDriver {
  send(on: boolean): Promise<void>;
}

// A session encapsulates how to wait for "ready to charge" and which driver to use.
// waitForStart() resolves when it is time to plan and begin charging.
export interface ChargingSession {
  waitForStart(): Promise<void>;
  driver: ChargerDriver;
}

export const simulateSession: ChargingSession = {
  waitForStart: async () => {},
  driver: {
    async send(on: boolean) {
      log(`[SIMULATE] → ${on ? "ON " : "OFF"}`);
    },
  },
};


export async function runCharging(slots: Slot[], driver: ChargerDriver): Promise<void> {
  const now = new Date();
  const upcoming = slots.filter((s) => s.end > now);

  const firstCharge = upcoming.find((s) => s.charge);
  if (!firstCharge) {
    log("No charge slots remaining in window.");
    return;
  }

  // Sleep directly to the first charge slot, skipping all the preceding OFF slots
  const msUntilFirst = firstCharge.start.getTime() - Date.now();
  if (msUntilFirst > 0) {
    log(`Charging starts at ${firstCharge.start.toLocaleTimeString()} (in ${Math.round(msUntilFirst / 1000)}s)`);
    await sleep(msUntilFirst);
  }

  // Execute from the first charge slot onward (handles any OFF slots between charge slots)
  for (const slot of upcoming.filter((s) => s.start >= firstCharge.start)) {
    const msUntilStart = slot.start.getTime() - Date.now();
    if (msUntilStart > 0) await sleep(msUntilStart);

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
