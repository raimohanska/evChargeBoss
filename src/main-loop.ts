import type { Config } from "./config.ts";
import type { Slot } from "./types.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./printer.ts";
import { runSlot } from "./charger.ts";
import { STATUS } from "./mqtt-status.ts";
import type { Publisher } from "./mqtt-status.ts";
import { Canceller, localTimeShort, log, realClock } from "./utils.ts";
import type { Clock } from "./utils.ts";
import type { ChargingSession } from "./charger.ts";

export interface SessionState {
  readonly chargedKwh: number;
  readonly replanController: Canceller;
  readonly planFrom: Date | undefined;
}

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

async function runSession(
  session: ChargingSession,
  publisher: Publisher,
  config: Config,
  state: SessionState,
  clock: Clock,
): Promise<SessionState> {
  publisher.setStatus(STATUS.waitingForCar);
  await session.waitForStart();

  let planFrom: Date | undefined = state.planFrom;
  state = { ...state, chargedKwh: 0, planFrom: undefined };
  let prevSlots: Slot[] | undefined;

  while (true) {
    const remainingKwh = Math.max(0, config.charging.targetKwh - state.chargedKwh);
    if (remainingKwh === 0) {
      log("Target kWh reached.");
      publisher.resetTargetTime();
      break;
    }

    publisher.setStatus(STATUS.fetchingData);
    state = { ...state, replanController: new Canceller() };
    publisher.setReplanCallback(() => state.replanController.abort());

    const targetTimeStr = publisher.getTargetTimeOverride() ?? config.charging.targetTime;
    const now = planFrom ?? clock.now();
    const targetDate = parseTargetTime(targetTimeStr, now);
    planFrom = undefined;

    const slots = await plan(now, targetDate, remainingKwh, config);

    if (state.replanController.signal.aborted) {
      log("Target time changed during planning — re-planning.");
      continue;
    }

    // Print the plan only when it changes (or on the very first plan).
    if (prevSlots === undefined || chargeSlotsChanged(prevSlots, slots)) {
      if (prevSlots !== undefined) log("Plan changed:");
      publisher.setPlan(slots);
      printPlan(slots);
    }
    prevSlots = slots;

    // Find the next charge slot that has not yet ended.
    const nextCharge = slots.find((s) => s.charge && s.end > clock.now());
    if (!nextCharge) {
      log("No charge slots remaining in window.");
      publisher.resetTargetTime();
      break;
    }

    publisher.setStatus(STATUS.plannedChargeStart(localTimeShort(nextCharge.start)));

    // Sleep until the next charge slot starts (relay OFF during the gap).
    const msUntilSlot = nextCharge.start.getTime() - clock.now().getTime();
    if (msUntilSlot > 0) {
      await session.driver.send(false);
      log(
        `Charging starts at ${localTimeShort(nextCharge.start)} (in ${Math.round(msUntilSlot / 1000)}s)`,
      );
      await clock.sleep(msUntilSlot, state.replanController.signal);
    }
    if (state.replanController.signal.aborted) {
      log("Target time changed — re-planning.");
      continue;
    }

    // Run the single slot.
    const chargeRunEnd = findChargeRunEnd(slots, nextCharge);
    const kwh = await runSlot(
      nextCharge,
      chargeRunEnd,
      session.driver,
      publisher,
      state.replanController.signal,
      session.wattsSource,
      state.chargedKwh,
      config.mqtt?.powerThresholdW ?? 10,
      config.charging.powerKw,
      clock,
    );
    state = { ...state, chargedKwh: state.chargedKwh + kwh };

    // Ensure relay is OFF between slots; runSlot already sends OFF on abort.
    if (!state.replanController.signal.aborted) {
      await session.driver.send(false);
      log("Charging session complete.");
    } else {
      log(
        `Target time changed — re-planning with ${(config.charging.targetKwh - state.chargedKwh).toFixed(2)} kWh remaining.`,
      );
    }
    // Always loop back to re-plan for the next slot.
  }

  publisher.setStatus(STATUS.idle);
  return state;
}

export async function runMainLoop(
  session: ChargingSession,
  publisher: Publisher,
  config: Config,
  initialFrom: Date | undefined,
  errorStatus: (err: unknown) => string,
  clock: Clock = realClock,
): Promise<void> {
  let state: SessionState = {
    chargedKwh: 0,
    replanController: new Canceller(),
    planFrom: initialFrom,
  };

  // The callback always aborts whichever replanController is current; since state
  // is a let-bound variable the closure always reads the latest assignment.
  publisher.setReplanCallback(() => state.replanController.abort());

  if (config.test?.justOnce) {
    if (state.planFrom) log(`Planning from ${state.planFrom.toISOString()}`);
    // Errors propagate in justOnce mode, making test failures visible immediately.
    state = await runSession(session, publisher, config, state, clock);
    return;
  }

  while (true) {
    if (state.planFrom) log(`Planning from ${state.planFrom.toISOString()}`);
    try {
      state = await runSession(session, publisher, config, state, clock);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${msg}`);
      publisher.setError(errorStatus(err));
      log("Retrying in 60s...");
      await clock.sleep(60_000);
    }
  }
}
