import type { Config } from "../config.ts";
import type { Slot } from "./types.ts";
import type { SessionSummary } from "../influx.ts";
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
  onSessionEnd?: (summary: SessionSummary) => Promise<void>,
): Promise<void> {
  publisher.setStatus(STATUS.waitingForCar);
  const powerKw = await session.waitForStart();

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
      const solarPct =
        chargeSlotsDone > 0 ? Math.round((solarFractionAccum / chargeSlotsDone) * 100) : 0;
      log(
        `Charging finished | ${chargedKwh.toFixed(2)} kWh charged, EUR ${chargedCostEur.toFixed(3)} total cost, ${solarPct}% solar`,
      );
      publisher.resetTargetTime();
      await session.driver.send(false);
      publisher.setStatus(STATUS.idle);
      await onSessionEnd?.({ chargedKwh, totalCostEur: chargedCostEur, solarPct });
      return;
    }

    replanController = new Canceller();
    updateReplanCallback();

    const targetTimeStr = publisher.getTargetTimeOverride() ?? config.evCharging.targetTime;
    const now = planFrom ?? clock.now();
    const targetDate = parseTargetTime(targetTimeStr, now);
    planFrom = undefined;

    const slots = await plan(
      now,
      targetDate,
      remainingKwh,
      powerKw,
      config,
      prevSlots === undefined,
    );

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
      const solarPct =
        chargeSlotsDone > 0 ? Math.round((solarFractionAccum / chargeSlotsDone) * 100) : 0;
      if (chargedKwh > 0) {
        log(
          `Charging finished | ${chargedKwh.toFixed(2)} kWh charged, EUR ${chargedCostEur.toFixed(3)} total cost, ${solarPct}% solar`,
        );
      }
      log("No charge slots remaining in window.");
      publisher.resetTargetTime();
      await session.driver.send(false);
      publisher.setStatus(STATUS.idle);
      await onSessionEnd?.({ chargedKwh, totalCostEur: chargedCostEur, solarPct });
      return;
    }

    // Sleep until the next charge slot starts (relay OFF during the gap).
    const msUntilSlot = nextCharge.start.getTime() - clock.now().getTime();
    // Only show "Planned charge start" when there is a meaningful wait ahead;
    // if the slot is already now, go straight to "Waiting for charging to start".
    if (msUntilSlot > 0) {
      publisher.setStatus(STATUS.plannedChargeStart(localTimeShort(nextCharge.start)));
    }
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
    const { kwh, carFinished } = await runSlot({
      slot: nextCharge,
      chargeRunEnd,
      driver: session.driver,
      publisher,
      signal: replanController.signal,
      wattsSource: session.wattsSource,
      prevChargedKwh: chargedKwh,
      powerThresholdW: config.evCharging.mqtt?.powerThresholdW ?? 10,
      powerKw,
      clock,
    });
    chargedKwh += kwh;
    if (kwh > 0) {
      chargedCostEur += nextCharge.effectiveCostEur;
      solarFractionAccum += Math.min(1, nextCharge.solarForecastW / 1000 / powerKw);
      chargeSlotsDone++;
      const solarPct = Math.round((solarFractionAccum / chargeSlotsDone) * 100);
      publisher.setAccumulatedCost(chargedCostEur);
      publisher.setAccumulatedSolarPct(solarPct);
    }

    // Car's battery is full — power dropped below threshold while relay was ON.
    // Exit now rather than starting the next slot and showing misleading statuses.
    if (carFinished && !replanController.signal.aborted) {
      const solarPct =
        chargeSlotsDone > 0 ? Math.round((solarFractionAccum / chargeSlotsDone) * 100) : 0;
      log(
        `Charging finished (car full) | ${chargedKwh.toFixed(2)} kWh charged, EUR ${chargedCostEur.toFixed(3)} total cost, ${solarPct}% solar`,
      );
      publisher.resetTargetTime();
      await session.driver.send(false);
      publisher.setStatus(STATUS.idle);
      await onSessionEnd?.({ chargedKwh, totalCostEur: chargedCostEur, solarPct });
      return;
    }

    if (replanController.signal.aborted) {
      log(
        `Target time changed — re-planning with ${(config.evCharging.targetKwh - chargedKwh).toFixed(2)} kWh remaining.`,
      );
      // Clear "Charging until …" so the next setStatus call is not suppressed.
      // Without this, shouldSuppressStatus would block "Waiting for charging to start"
      // when the re-planned slot starts, leaving the UI stuck on the old status
      // even though the relay was just turned off.
      publisher.setStatus(STATUS.replanning);
    }
    // Relay stays ON after a normal slot. The next iteration will send OFF
    // before sleeping if there is a gap, keeping the relay on for back-to-back
    // charge slots without an OFF→ON toggle.
    // Always loop back to re-plan for the next slot.
  }
}

/**
 * Returns true when the set of charge-slot start times differs between two plans,
 * considering only slots that fall within the new plan's time window so that a
 * naturally shrinking window (consumed slots dropping off) is not treated as a change.
 */
function chargeSlotsChanged(prev: Slot[], next: Slot[]): boolean {
  const from = next[0]?.start.getTime() ?? 0;
  const times = (slots: Slot[]) =>
    slots.filter((s) => s.charge && s.start.getTime() >= from).map((s) => s.start.getTime());
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
