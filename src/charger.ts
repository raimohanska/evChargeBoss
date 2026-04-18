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

  // Sleep directly to the first charge slot, skipping all the preceding OFF slots
  const msUntilFirst = firstCharge.start.getTime() - Date.now();
  if (msUntilFirst > 0) {
    await driver.send(false);
    log(`Charging starts at ${localTimeShort(firstCharge.start)} (in ${Math.round(msUntilFirst / 1000)}s)`);
    await sleepAbortable(msUntilFirst, signal);
  }
  if (signal?.aborted) return 0;

  let completedChargeSlots = 0;
  const slotsToExecute = upcoming.filter((s) => s.start >= firstCharge.start);

  // Execute from the first charge slot onward (handles any OFF slots between charge slots)
  for (let i = 0; i < slotsToExecute.length; i++) {
    const slot = slotsToExecute[i];
    const msUntilStart = slot.start.getTime() - Date.now();
    if (msUntilStart > 0) await sleepAbortable(msUntilStart, signal);
    if (signal?.aborted) break;

    // Update status: for charge slots show end of this consecutive run; for gaps show next charge start
    if (slot.charge) {
      let runEnd = slot.end;
      for (let j = i + 1; j < slotsToExecute.length && slotsToExecute[j].charge; j++) {
        runEnd = slotsToExecute[j].end;
      }
      publisher?.setStatus(STATUS.charging(localTimeShort(runEnd)));
    } else {
      const nextCharge = slotsToExecute.slice(i + 1).find(s => s.charge);
      if (nextCharge) publisher?.setStatus(STATUS.chargePaused(localTimeShort(nextCharge.start)));
    }

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
