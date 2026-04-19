import { CONFIG } from "./config.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./printer.ts";
import { runCharging } from "./charger.ts";
import { getTargetTime, STATUS, StatusPublisher } from "./mqtt-status.ts";
import { Canceller, localTimeShort, log, sleep } from "./utils.ts";
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

export async function runMainLoop(
  session: ChargingSession,
  publisher: StatusPublisher | undefined,
  initialFrom: Date | undefined,
  errorStatus: (err: unknown) => string,
): Promise<never> {
  // replanController is replaced each inner-loop iteration; the callback always aborts the current one.
  let replanController = new Canceller();
  publisher?.setReplanCallback(() => replanController.abort());

  let from = initialFrom;
  while (true) {
    if (from) log(`Planning from ${from.toISOString()}`);
    try {
      publisher?.setStatus(STATUS.waitingForCar);
      await session.waitForStart();

      let chargedKwh = 0;
      let planFrom = from;
      from = undefined;

      // Inner loop: re-plan whenever the target time changes mid-session.
      while (true) {
        const remainingKwh = Math.max(0, CONFIG.charging.targetKwh - chargedKwh);
        if (remainingKwh === 0) { log("Target kWh already reached."); break; }

        publisher?.setStatus(STATUS.fetchingData);
        replanController = new Canceller();

        const targetTimeStr = publisher ? getTargetTime() : CONFIG.charging.targetTime;
        const planFrom_ = planFrom ?? new Date();
        const targetDate = parseTargetTime(targetTimeStr, planFrom_);

        const slots = await plan(planFrom_, targetDate, remainingKwh);
        planFrom = undefined;

        if (replanController.signal.aborted) {
          log("Target time changed during planning — re-planning.");
          continue;
        }

        publisher?.setPlan(slots);
        printPlan(slots);
        const firstCharge = slots.find(s => s.charge);
        publisher?.setStatus(firstCharge
          ? STATUS.plannedChargeStart(localTimeShort(firstCharge.start))
          : STATUS.idle);

        const newlyCharged = await runCharging(slots, session.driver, publisher, replanController.signal, session.wattsSource, chargedKwh);
        chargedKwh += newlyCharged;

        if (!replanController.signal.aborted) {
          publisher?.resetTargetTime();
          break; // session complete
        }
        log(`Target time changed — re-planning with ${(CONFIG.charging.targetKwh - chargedKwh).toFixed(2)} kWh remaining.`);
      }

      publisher?.setStatus(STATUS.idle);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`ERROR: ${msg}`);
      publisher?.setError(errorStatus(err));
      log("Retrying in 60s...");
      await sleep(60_000);
    }
  }
}
