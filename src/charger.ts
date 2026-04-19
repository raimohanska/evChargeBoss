import type { Slot } from "./types.ts";
import { STATUS } from "./mqtt-status.ts";
import type { StatusPublisher } from "./mqtt-status.ts";
import { CONFIG } from "./config.ts";
import type { CancelSignal } from "./utils.ts";
import { log, localTimeShort, sleepAbortable } from "./utils.ts";

export interface ChargerDriver {
  send(on: boolean): Promise<void>;
}

export interface WattsUpdate {
  watts: number;
  energyKwh?: number; // cumulative relay energy reading, if available
}

export interface WattsSource {
  subscribe(cb: (update: WattsUpdate) => void): () => void;
}

// A session encapsulates how to wait for "ready to charge" and which driver to use.
// waitForStart() resolves when it is time to plan and begin charging.
export interface ChargingSession {
  waitForStart(): Promise<void>;
  driver: ChargerDriver;
  wattsSource?: WattsSource;
}

const SIM_TICK_MS = 2000;

/** Simulated session with randomised watts that mimic a real EV charging cycle. */
export function makeSimulateSession(): ChargingSession {
  const listeners: Array<(u: WattsUpdate) => void> = [];
  let chargerOn = false;
  let cumulativeEnergyKwh = 0;
  let startHandle: ReturnType<typeof setTimeout> | null = null;
  let tickHandle:  ReturnType<typeof setInterval> | null = null;

  function notify(u: WattsUpdate) {
    for (const l of listeners) l(u);
  }

  function startEmitting() {
    // Simulate car startup handshake: 2–6 s before watts appear
    const delay = 2000 + Math.random() * 4000;
    startHandle = setTimeout(() => {
      startHandle = null;
      if (!chargerOn) return;
      const w = 2900 + Math.random() * 200;
      cumulativeEnergyKwh += (w / 1000) * (SIM_TICK_MS / 3_600_000);
      notify({ watts: w, energyKwh: cumulativeEnergyKwh });
      tickHandle = setInterval(() => {
        if (!chargerOn) return;
        // ~3% chance of a brief pause (EV battery management / balancing)
        const w = Math.random() < 0.03 ? 0 : 2900 + Math.random() * 200;
        cumulativeEnergyKwh += (w / 1000) * (SIM_TICK_MS / 3_600_000);
        notify({ watts: w, energyKwh: cumulativeEnergyKwh });
      }, SIM_TICK_MS);
    }, delay);
  }

  function stopEmitting() {
    if (startHandle !== null) { clearTimeout(startHandle); startHandle = null; }
    if (tickHandle  !== null) { clearInterval(tickHandle); tickHandle  = null; }
    notify({ watts: 0, energyKwh: cumulativeEnergyKwh });
  }

  return {
    waitForStart: async () => {},
    driver: {
      async send(on: boolean) {
        log(`[SIMULATE] → ${on ? "ON " : "OFF"}`);
        chargerOn = on;
        if (on) startEmitting();
        else    stopEmitting();
      },
    },
    wattsSource: {
      subscribe(cb) {
        listeners.push(cb);
        return () => {
          const i = listeners.indexOf(cb);
          if (i !== -1) listeners.splice(i, 1);
        };
      },
    },
  };
}

/**
 * Runs the charging schedule. Returns kWh delivered in fully-completed charge slots.
 * If signal is aborted mid-session the charger is turned off and the function returns early.
 * If wattsSource is provided, status reflects actual watts rather than the schedule alone.
 */
export async function runCharging(
  slots: Slot[],
  driver: ChargerDriver,
  publisher?: StatusPublisher,
  signal?: CancelSignal,
  wattsSource?: WattsSource,
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

  // Watts-based status + energy tracking
  const threshold = CONFIG.mqtt?.powerThresholdW ?? 10;
  let activeRunEnd: Date | null = null;  // non-null only while in a charge slot
  let chargeRunActive = false;           // true once watts seen in current charge run
  let startEnergy: number | null = null; // relay energy reading at session start

  const unsubWatts = wattsSource?.subscribe(({ watts, energyKwh }) => {
    // Energy tracking
    if (energyKwh !== undefined) {
      if (startEnergy === null) startEnergy = energyKwh;
      publisher?.setChargedEnergy(energyKwh - startEnergy);
    }
    // Status tracking
    if (activeRunEnd === null || !publisher) return;
    if (watts > threshold) {
      chargeRunActive = true;
      publisher.setStatus(STATUS.charging(localTimeShort(activeRunEnd)));
    } else if (chargeRunActive) {
      publisher.setStatus(STATUS.chargingFinished);
    }
    // if !chargeRunActive: stay at "Waiting for charging to start"
  });

  let completedChargeSlots = 0;
  let prevSlotCharge = false;
  const slotsToExecute = upcoming.filter((s) => s.start >= firstCharge.start);

  // Execute from the first charge slot onward (handles any OFF slots between charge slots)
  for (let i = 0; i < slotsToExecute.length; i++) {
    const slot = slotsToExecute[i];
    const msUntilStart = slot.start.getTime() - Date.now();
    if (msUntilStart > 0) await sleepAbortable(msUntilStart, signal);
    if (signal?.aborted) break;

    if (slot.charge) {
      // Find end of this consecutive charging run
      let runEnd = slot.end;
      for (let j = i + 1; j < slotsToExecute.length && slotsToExecute[j].charge; j++) {
        runEnd = slotsToExecute[j].end;
      }
      activeRunEnd = runEnd;

      if (!prevSlotCharge) {
        // Starting a new charge run
        chargeRunActive = false;
        publisher?.setStatus(wattsSource
          ? STATUS.waitingForChargingToStart
          : STATUS.charging(localTimeShort(runEnd)));
      }
      // If continuing a run, the watts callback manages the status
    } else {
      activeRunEnd = null;
      const nextCharge = slotsToExecute.slice(i + 1).find(s => s.charge);
      if (nextCharge) publisher?.setStatus(STATUS.chargePaused(localTimeShort(nextCharge.start)));
    }

    const label = slot.charge
      ? slot.effectiveCostEur === 0 ? "solar-free" : `${slot.effectiveCostEur.toFixed(3)} €`
      : "too expensive";
    log(`[${slot.charge ? "ON " : "OFF"}] ${localTimeShort(slot.start)}–${localTimeShort(slot.end)} | ${label}`);
    await driver.send(slot.charge);
    prevSlotCharge = slot.charge;

    const msUntilEnd = slot.end.getTime() - Date.now();
    if (msUntilEnd > 0) await sleepAbortable(msUntilEnd, signal);

    if (signal?.aborted) {
      if (slot.charge) await driver.send(false);
      break;
    }

    if (slot.charge) completedChargeSlots++;
  }

  unsubWatts?.();
  if (!signal?.aborted) log("Charging session complete.");
  return completedChargeSlots * CONFIG.charging.powerKw * 0.25;
}
