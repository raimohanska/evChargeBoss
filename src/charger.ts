import type { Slot } from "./types.ts";
import { STATUS } from "./mqtt-status.ts";
import type { StatusPublisher } from "./mqtt-status.ts";
import { CONFIG } from "./config.ts";
import type { CancelSignal } from "./utils.ts";
import { log, localTimeShort, sleepAbortable } from "./utils.ts";

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


/**
 * Runs the charging schedule. Returns kWh delivered in fully-completed charge slots.
 * If signal is aborted mid-session the charger is turned off and the function returns early.
 */
export async function runCharging(
  slots: Slot[],
  driver: ChargerDriver,
  publisher?: StatusPublisher,
  signal?: CancelSignal,
): Promise<number> {
  const now = new Date();
  const upcoming = slots.filter((s) => s.end > now);

  const firstCharge = upcoming.find((s) => s.charge);
  if (!firstCharge) {
    log("No charge slots remaining in window.");
    return 0;
  }

  const chargeSlots = upcoming.filter(s => s.charge);
  const lastCharge = chargeSlots[chargeSlots.length - 1];

  // Sleep directly to the first charge slot, skipping all the preceding OFF slots
  const msUntilFirst = firstCharge.start.getTime() - Date.now();
  if (msUntilFirst > 0) {
    await driver.send(false);
    log(`Charging starts at ${localTimeShort(firstCharge.start)} (in ${Math.round(msUntilFirst / 1000)}s)`);
    await sleepAbortable(msUntilFirst, signal);
  }
  if (signal?.aborted) return 0;
  publisher?.setStatus(STATUS.charging(localTimeShort(lastCharge.end)));

  let completedChargeSlots = 0;

  // Execute from the first charge slot onward (handles any OFF slots between charge slots)
  for (const slot of upcoming.filter((s) => s.start >= firstCharge.start)) {
    const msUntilStart = slot.start.getTime() - Date.now();
    if (msUntilStart > 0) await sleepAbortable(msUntilStart, signal);
    if (signal?.aborted) break;

    const label = slot.charge
      ? slot.effectiveCostEur === 0 ? "solar-free" : `${slot.effectiveCostEur.toFixed(3)} €`
      : "too expensive";
    log(`[${slot.charge ? "ON " : "OFF"}] ${localTimeShort(slot.start)}–${localTimeShort(slot.end)} | ${label}`);
    await driver.send(slot.charge);

    const msUntilEnd = slot.end.getTime() - Date.now();
    if (msUntilEnd > 0) await sleepAbortable(msUntilEnd, signal);

    if (signal?.aborted) {
      if (slot.charge) await driver.send(false);
      break;
    }

    if (slot.charge) completedChargeSlots++;
  }

  if (!signal?.aborted) log("Charging session complete.");
  return completedChargeSlots * CONFIG.charging.powerKw * 0.25;
}
