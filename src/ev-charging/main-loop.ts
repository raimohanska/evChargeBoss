import type { Config } from "../config.ts";
import type { Slot } from "./types.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./print-plan.ts";
import { runSlot } from "./charger.ts";
import { STATUS } from "./mqtt-status.ts";
import type { Publisher } from "./mqtt-status.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";
import { Canceller } from "../utils/timing-utils.ts";
import type { Clock } from "../utils/timing-utils.ts";
import type { ChargingSession } from "./charger.ts";

export function parseTargetTime(timeStr: string, from: Date): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const today = new Date(from);
  today.setHours(h, m, 0, 0);
  if (today > from) return today;
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(h, m, 0, 0);
  return tomorrow;
}

/**
 * Runs one complete charging session: waits for plug-in, plans, charges one
 * slot at a time until the target kWh is reached or no slots remain.
 * Replans whenever the target time changes (via publisher.setReplanCallback).
 *
 * @param from  Virtual start time for planning (undefined = clock.now()).
 */
export async function runSession(
  session: ChargingSession,
  publisher: Publisher,
  config: Config,
  from: Date | undefined,
  clock: Clock,
): Promise<void> {
  publisher.setStatus(STATUS.waitingForCar);
  await session.waitForStart();

  let planFrom: Date | undefined = from;
  let chargedKwh = 0;
  let chargedCostEur = 0;
  let solarFractionAccum = 0;
  let chargeSlotsDone = 0;
  let prevSlots: Slot[] | undefined;
  let replanController = new Canceller();

  // Keep the replan callback pointed at the current controller.
  const updateReplanCallback = () => publisher.setReplanCallback(() => replanController.abort());
  updateReplanCallback();

  while (true) {
    const remainingKwh = Math.max(0, config.evCharging.targetKwh - chargedKwh);
    if (remainingKwh === 0) {
      log("Target kWh reached.");
      publisher.resetTargetTime();
      await session.driver.send(false);
      publisher.setStatus(STATUS.idle);
      return;
    }

    publisher.setStatus(STATUS.fetchingData);
    replanController = new Canceller();
    updateReplanCallback();

    const targetTimeStr = publisher.getTargetTimeOverride() ?? config.evCharging.targetTime;
    const now = planFrom ?? clock.now();
    const targetDate = parseTargetTime(targetTimeStr, now);
    planFrom = undefined;

    const slots = await plan(now, targetDate, remainingKwh, config);

    if (replanController.signal.aborted) {
      log("Target time changed during planning — re-planning.");
      continue;
    }

    // Print the plan only when it changes (or on the very first plan).
    if (prevSlots === undefined || chargeSlotsChanged(prevSlots, slots)) {
      if (prevSlots !== undefined) log("Plan changed:");
      publisher.setPlan(slots);
      printPlan(slots);
      log(
        `[Plan] Target: ${config.evCharging.targetKwh.toFixed(2)} kWh` +
          (chargedKwh > 0 ? ` | Charged so far: ${chargedKwh.toFixed(2)} kWh` : "") +
          ` | Remaining: ${remainingKwh.toFixed(2)} kWh`,
      );
    }
    prevSlots = slots;

    // Find the next charge slot that has not yet ended.
    const nextCharge = slots.find((s) => s.charge && s.end > clock.now());
    if (!nextCharge) {
      log("No charge slots remaining in window.");
      publisher.resetTargetTime();
      await session.driver.send(false);
      publisher.setStatus(STATUS.idle);
      return;
    }

    publisher.setStatus(STATUS.plannedChargeStart(localTimeShort(nextCharge.start)));

    // Sleep until the next charge slot starts (relay OFF during the gap).
    const msUntilSlot = nextCharge.start.getTime() - clock.now().getTime();
    if (msUntilSlot > 0) {
      await session.driver.send(false);
      log(
        `Charging starts at ${localTimeShort(nextCharge.start)} (in ${Math.round(msUntilSlot / 1000)}s)`,
      );
      await clock.sleep(msUntilSlot, replanController.signal);
    }
    if (replanController.signal.aborted) {
      log("Target time changed — re-planning.");
      continue;
    }

    // Run the single slot.
    const chargeRunEnd = findChargeRunEnd(slots, nextCharge);
    const kwh = await runSlot({
      slot: nextCharge,
      chargeRunEnd,
      driver: session.driver,
      publisher,
      signal: replanController.signal,
      wattsSource: session.wattsSource,
      prevChargedKwh: chargedKwh,
      powerThresholdW: config.evCharging.mqtt?.powerThresholdW ?? 10,
      powerKw: config.evCharging.powerKw,
      clock,
    });
    chargedKwh += kwh;
    if (kwh > 0) {
      chargedCostEur += nextCharge.effectiveCostEur;
      solarFractionAccum += Math.min(
        1,
        nextCharge.solarForecastW / 1000 / config.evCharging.powerKw,
      );
      chargeSlotsDone++;
      const solarPct = Math.round((solarFractionAccum / chargeSlotsDone) * 100);
      publisher.setAccumulatedCost(chargedCostEur);
      publisher.setAccumulatedSolarPct(solarPct);
      log(
        `[Status] Charging finished | ${chargedKwh.toFixed(2)} kWh charged, \u20ac${chargedCostEur.toFixed(3)} total cost, ${solarPct}% solar`,
      );
    }

    if (replanController.signal.aborted) {
      log(
        `Target time changed — re-planning with ${(config.evCharging.targetKwh - chargedKwh).toFixed(2)} kWh remaining.`,
      );
    }
    // Relay stays ON after a normal slot. The next iteration will send OFF
    // before sleeping if there is a gap, keeping the relay on for back-to-back
    // charge slots without an OFF→ON toggle.
    // Always loop back to re-plan for the next slot.
  }
}

/** Returns true when the set of charge-slot start times differs between two plans. */
function chargeSlotsChanged(prev: Slot[], next: Slot[]): boolean {
  const times = (slots: Slot[]) => slots.filter((s) => s.charge).map((s) => s.start.getTime());
  const a = times(prev);
  const b = times(next);
  return a.length !== b.length || a.some((t, i) => t !== b[i]);
}

/** Returns the end of the consecutive charge run that startSlot belongs to. */
function findChargeRunEnd(slots: Slot[], startSlot: Slot): Date {
  const idx = slots.indexOf(startSlot);
  let end = startSlot.end;
  for (let i = idx + 1; i < slots.length && slots[i].charge; i++) {
    end = slots[i].end;
  }
  return end;
}
