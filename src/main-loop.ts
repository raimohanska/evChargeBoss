import type { Config } from "./config.ts";
import { plan } from "./planner.ts";
import { printPlan } from "./printer.ts";
import { runCharging } from "./charger.ts";
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

async function runSession(
  session: ChargingSession,
  publisher: Publisher,
  config: Config,
  state: SessionState,
  clock: Clock,
): Promise<SessionState> {
  publisher.setStatus(STATUS.waitingForCar);
  await session.waitForStart();

  // Extract planFrom before clearing it; reset session counters
  let planFrom: Date | undefined = state.planFrom;
  state = { ...state, chargedKwh: 0, planFrom: undefined };

  // Inner loop: re-plan whenever the target time changes mid-session.
  while (true) {
    const remainingKwh = Math.max(0, config.charging.targetKwh - state.chargedKwh);
    if (remainingKwh === 0) { log("Target kWh already reached."); break; }

    publisher.setStatus(STATUS.fetchingData);
    state = { ...state, replanController: new Canceller() };
    // Keep the callback pointed at the current replanController; runMainLoop's
    // closure over its own `state` would still reference the pre-session object.
    publisher.setReplanCallback(() => state.replanController.abort());

    const targetTimeStr = publisher.getTargetTimeOverride() ?? config.charging.targetTime;
    const planFrom_ = planFrom ?? clock.now();
    const targetDate = parseTargetTime(targetTimeStr, planFrom_);

    const slots = await plan(planFrom_, targetDate, remainingKwh, config);
    planFrom = undefined;

    if (state.replanController.signal.aborted) {
      log("Target time changed during planning — re-planning.");
      continue;
    }

    
    publisher.setPlan(slots);
    printPlan(slots);
    const firstCharge = slots.find(s => s.charge);
    publisher.setStatus(firstCharge
      ? STATUS.plannedChargeStart(localTimeShort(firstCharge.start))
      : STATUS.idle);

    const newlyCharged = await runCharging(
      slots, session.driver, publisher, state.replanController.signal, session.wattsSource,
      state.chargedKwh, config.mqtt?.powerThresholdW ?? 10, config.charging.powerKw, clock,
    );
    state = { ...state, chargedKwh: state.chargedKwh + newlyCharged };

    if (!state.replanController.signal.aborted) {
      publisher.resetTargetTime();
      break; // session complete
    }
    log(`Target time changed — re-planning with ${(config.charging.targetKwh - state.chargedKwh).toFixed(2)} kWh remaining.`);
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
