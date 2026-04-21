import type { Slot } from './types.ts';
import { STATUS } from './mqtt-status.ts';
import type { Publisher } from './mqtt-status.ts';
import type { CancelSignal } from './utils.ts';
import { log, localTimeShort, realClock } from './utils.ts';
import type { Clock } from './utils.ts';

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
  end(): void;
}

/**
 * Runs the charging schedule.
 * Returns kWh delivered: relay energy delta when available, otherwise completed slots × powerKw × 0.25.
 * If signal is aborted mid-session the charger is turned off and the function returns early.
 * If wattsSource is provided, status reflects actual watts rather than the schedule alone.
 * prevChargedKwh: energy already charged earlier in this session (for cumulative display).
 */
export async function runCharging(
  slots: Slot[],
  driver: ChargerDriver,
  publisher?: Publisher,
  signal?: CancelSignal,
  wattsSource?: WattsSource,
  prevChargedKwh = 0,
  powerThresholdW = 10,
  powerKw = 0,
  clock: Clock = realClock,
): Promise<number> {
  const now = clock.now();
  const upcoming = slots.filter((s) => s.end > now);

  const firstCharge = upcoming.find((s) => s.charge);
  if (!firstCharge) {
    log('No charge slots remaining in window.');
    return 0;
  }

  // Sleep directly to the first charge slot, skipping all the preceding OFF slots
  const msUntilFirst = firstCharge.start.getTime() - clock.now().getTime();
  if (msUntilFirst > 0) {
    await driver.send(false);
    log(
      `Charging starts at ${localTimeShort(firstCharge.start)} (in ${Math.round(msUntilFirst / 1000)}s)`,
    );
    await clock.sleep(msUntilFirst, signal);
  }
  if (signal?.aborted) return 0;

  // Watts-based status + energy tracking
  let activeRunEnd: Date | null = null; // non-null only while in a charge slot
  let chargeRunActive = false; // true once watts seen in current charge run
  let startEnergy: number | null = null; // relay energy reading at this run's start
  let lastEnergy: number | null = null; // most recent relay energy reading

  const unsubWatts = wattsSource?.subscribe(({ watts, energyKwh }) => {
    // Energy tracking
    if (energyKwh !== undefined) {
      if (startEnergy === null) startEnergy = energyKwh;
      lastEnergy = energyKwh;
      publisher?.setChargedEnergy(prevChargedKwh + energyKwh - startEnergy);
    }
    // Status tracking
    if (activeRunEnd === null || !publisher) return;
    if (watts > powerThresholdW) {
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
    const msUntilStart = slot.start.getTime() - clock.now().getTime();
    if (msUntilStart > 0) await clock.sleep(msUntilStart, signal);
    if (signal?.aborted) break;

    if (slot.charge) {
      // Find end of this consecutive charging run
      let runEnd = slot.end;
      for (
        let j = i + 1;
        j < slotsToExecute.length && slotsToExecute[j].charge;
        j++
      ) {
        runEnd = slotsToExecute[j].end;
      }
      activeRunEnd = runEnd;

      if (!prevSlotCharge) {
        // Starting a new charge run
        chargeRunActive = false;
        publisher?.setStatus(
          wattsSource
            ? STATUS.waitingForChargingToStart
            : STATUS.charging(localTimeShort(runEnd)),
        );
      }

      // If continuing a run, the watts callback manages the status
    } else {
      activeRunEnd = null;
      const nextCharge = slotsToExecute.slice(i + 1).find((s) => s.charge);
      if (nextCharge)
        publisher?.setStatus(
          STATUS.chargePaused(localTimeShort(nextCharge.start)),
        );
    }

    const label = slot.charge
      ? slot.effectiveCostEur === 0
        ? 'solar-free'
        : `${slot.effectiveCostEur.toFixed(3)} €`
      : 'too expensive';
    log(
      `[${slot.charge ? 'ON ' : 'OFF'}] ${localTimeShort(slot.start)}–${localTimeShort(slot.end)} | ${label}`,
    );

    await driver.send(slot.charge);
    prevSlotCharge = slot.charge;

    const msUntilEnd = slot.end.getTime() - clock.now().getTime();
    if (msUntilEnd > 0) await clock.sleep(msUntilEnd, signal);

    if (signal?.aborted) {
      if (slot.charge) await driver.send(false);
      break;
    }

    if (slot.charge) completedChargeSlots++;
  }

  unsubWatts?.();
  if (!signal?.aborted) log('Charging session complete.');
  // Prefer relay-measured energy; fall back to plan-based estimate
  if (startEnergy !== null && lastEnergy !== null) {
    return lastEnergy - startEnergy;
  }
  return completedChargeSlots * powerKw * 0.25;
}
