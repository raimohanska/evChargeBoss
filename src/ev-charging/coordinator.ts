import type { Config } from "../config.ts";
import type { SessionSummary } from "../influx.ts";
import type { StatusPublisher } from "./mqtt-status.ts";
import type { ChargingSession } from "./charger.ts";
import { makeDebouncedDriver } from "./charger.ts";
import type { Clock } from "../utils/timing-utils.ts";
import type { Environment, MachineState } from "./state-machine.ts";
import { z } from "zod";
import { fetchPlanInputs } from "./planner.ts";
import { IncompleteDataError } from "../electricity/IncompleteDataError.ts";
import { getState, getStatus, nextState } from "./state-machine.ts";
import { Canceller } from "../utils/timing-utils.ts";
import { makeLogger } from "../utils/log.ts";
import {
  findNewestPlanFile,
  readPlanFile,
  writePlanFile,
  planFilePath,
  timestampForFilename,
} from "../utils/plan-store.ts";
import { localDateTimeString } from "../utils/date-time-format.ts";
import { sessionSummaryLine } from "./print-plan.ts";
import { type PricedSlot } from "../electricity/types.ts";
import { parseTargetTime } from "./helpers.ts";
import type { HeatingTracker } from "./heating-tracker.ts";
const log = makeLogger("ev-charging");

const EvChargingPlanSchema = z.object({
  version: z.literal(1),
  detectedPowerKw: z.number(),
  chargedKwh: z.number(),
  chargeLevelPct: z.number().optional(),
  config: z.object({
    targetKwh: z.number(),
    targetDateTime: z.string(),
  }),
});

interface InitialStateResult {
  state: MachineState;
  isResuming: boolean;
  chargeLevelPct?: number;
}

function getInitialState(
  config: Config,
  targetTime: Date,
  targetKwh: number,
  plansDir?: string,
): InitialStateResult {
  // Try to resume from a persisted plan file.
  const planPath = findNewestPlanFile("ev-charging", plansDir);
  if (planPath) {
    const saved = readPlanFile(planPath, EvChargingPlanSchema);
    if (
      saved &&
      saved.config.targetKwh === targetKwh &&
      new Date(saved.config.targetDateTime).getTime() === targetTime.getTime() &&
      saved.chargedKwh < targetKwh
    ) {
      // Compute the effective targetKwh for display (same formula as getAdjustedTargetKwh)
      const effectiveTargetKwh =
        saved.chargeLevelPct !== undefined
          ? targetKwh * Math.max(0, (100 - saved.chargeLevelPct) / 100)
          : targetKwh;
      log(
        `Resuming session: ${sessionSummaryLine({ powerKw: saved.detectedPowerKw, targetTime, targetKwh: effectiveTargetKwh, chargedKwh: saved.chargedKwh })}`,
      );
      return {
        state: {
          plan: null,
          id: "Planning",
          chargedKwh: saved.chargedKwh,
          detectedChargerPowerKw: saved.detectedPowerKw,
          powerKwMeasured: true, // previous session measured this value
        },
        isResuming: true,
        chargeLevelPct: saved.chargeLevelPct,
      };
    } else {
      let reason: string;
      if (!saved) {
        reason = "plan file unreadable";
      } else if (saved.config.targetKwh !== targetKwh) {
        reason = `targetKwh mismatch: saved=${saved.config.targetKwh}, config=${targetKwh}`;
      } else if (new Date(saved.config.targetDateTime).getTime() !== targetTime.getTime()) {
        reason = `targetDateTime mismatch: saved=${saved.config.targetDateTime}, config=${localDateTimeString(targetTime)}`;
      } else {
        reason = `session already complete: chargedKwh=${saved.chargedKwh} >= targetKwh=${targetKwh}`;
      }
      log(`Plan file found but not applicable (${planPath}): ${reason} - starting fresh.`);
    }
  }

  return {
    state: {
      id: "WaitingForCar",
      plan: null,
      chargedKwh: 0,
      detectedChargerPowerKw: config.evCharging.powerKw ?? 0,
      powerKwMeasured: false,
    },
    isResuming: false,
  };
}

export async function runSession(
  session: ChargingSession,
  publisher: StatusPublisher,
  config: Config,
  from: Date | undefined,
  clock: Clock,
  onSessionEnd?: (summary: SessionSummary) => Promise<void>,
  tracker?: HeatingTracker | null,
  plansDir?: string,
): Promise<void> {
  const RELAY_DEBOUNCE_MS = 1000;
  // Fixed per-session timestamp, used only to name the plan file. Never use
  // this as "current time" - always call clock.now() for that.
  const sessionStart = from ?? clock.now();
  const powerThresholdW = config.evCharging.mqtt?.powerThresholdW ?? 10;
  const powerKw = config.evCharging.powerKw ?? 0;
  const slotMs = 15 * 60 * 1000;

  const getTargetTimeFromPublisher = () => {
    // Always anchor on the current time. Resolving a relative override
    // (e.g. Charge Now -> "now + 2h") against a stale anchor could place the
    // target in the past and end the session immediately.
    const at = clock.now();
    const override = publisher.getTargetTimeOverride();
    if (override) return parseTargetTime(override, at);
    return publisher.resolveTargetTimeFromSchedule(at);
  };

  const getEffectiveTargetKwh = () =>
    publisher.getTargetKwhOverride() ?? config.evCharging.targetKwh;

  let targetTime = getTargetTimeFromPublisher();
  let targetKwh = getEffectiveTargetKwh();
  let currentPowerW = 0;
  let heatingHold = false;
  let relayOn: boolean | null = null;
  let totalCostEur = 0;
  let solarFractionSum = 0;
  let chargedSlots = 0;
  let forecast: PricedSlot[] | null = null;

  const initial = getInitialState(config, targetTime, targetKwh, plansDir);
  let machine: MachineState = initial.state;
  let chargeLevelPct: number | undefined = initial.chargeLevelPct;
  let chargeLevelTriggeredReplan = false;
  // Mutable holder so the charge level callback can access wakeCancel (declared later)
  const wakeRef: { cancel: Canceller | null } = { cancel: null };

  // Subscribe to charge level source (car SoC %) if configured.
  // Only track charge level for new sessions - resumed sessions use stored values.
  // Re-plan on charge level change only if we haven't started charging yet (chargedKwh == 0).
  const unsubChargeLevel = initial.isResuming
    ? undefined
    : session.chargeLevelSource?.subscribe((pct) => {
        const prevPct = chargeLevelPct;
        chargeLevelPct = pct;
        // Trigger re-plan only if chargedKwh is still 0 (not yet started charging)
        // and the charge level actually changed
        if (machine.chargedKwh === 0 && prevPct !== undefined && prevPct !== pct) {
          log(`Charge level changed to ${pct}% - re-planning (chargedKwh=0)`);
          forecast = null;
          chargeLevelTriggeredReplan = true;
          wakeRef.cancel?.abort();
        }
      });

  // Compute effective target kWh based on charge level: if battery is X% full, reduce target to (100-X)%
  const getAdjustedTargetKwh = () =>
    chargeLevelPct !== undefined
      ? targetKwh * Math.max(0, (100 - chargeLevelPct) / 100)
      : targetKwh;

  const savePlan = () => {
    const filePath = planFilePath("ev-charging", timestampForFilename(sessionStart), plansDir);
    writePlanFile(filePath, {
      version: 1,
      detectedPowerKw: machine.detectedChargerPowerKw,
      chargedKwh: machine.chargedKwh,
      ...(chargeLevelPct !== undefined && { chargeLevelPct }),
      config: {
        targetKwh: targetKwh,
        targetDateTime: localDateTimeString(targetTime),
      },
    });
  };

  const env = (): Environment => ({
    now: clock.now(),
    targetTime,
    currentPowerW,
    heatingHold,
    forecast,
    powerThresholdW,
    targetKwh: getAdjustedTargetKwh(),
    powerHoldFactor: tracker?.getLatest()?.powerHoldFactor ?? 1.0,
    chargeLevelPct,
  });

  const updateState = async () => {
    machine = nextState(machine, env());
    savePlan();
    await publishState();
  };

  const debouncedDriver = makeDebouncedDriver(session.driver, clock, RELAY_DEBOUNCE_MS, (err) =>
    log(`Relay send error: ${String(err)}`),
  );

  const publishState = async () => {
    publisher.setStatus(getStatus(machine, env()));
    publisher.setChargedEnergy(machine.chargedKwh);
    if (machine.plan !== null) {
      publisher.setPlan(machine.plan);
    } else {
      publisher.clearPlan();
    }
    const want = getState(machine.id).relayOn;
    if (want === relayOn) return;
    relayOn = want;
    await debouncedDriver.send(relayOn);
  };
  await publishState();

  let wakeCancel = new Canceller();
  wakeRef.cancel = wakeCancel;
  publisher.setWakeCallback(() => wakeCancel.abort());
  publisher.setChargeNowCallback(() => {
    machine = { ...machine, chargedKwh: 0 };
  });

  let latestEnergyKwh: number | undefined = undefined;
  let slotMeterStartKwh: number | undefined = undefined;

  const unsubWatts = session.wattsSource?.subscribe(({ watts, energyKwh }) => {
    currentPowerW = watts;
    if (energyKwh !== undefined) {
      latestEnergyKwh = energyKwh;
      if (machine.id === "ChargingAsPlanned" && slotMeterStartKwh !== undefined) {
        const slotKwh = latestEnergyKwh - slotMeterStartKwh;
        if (slotKwh > 0) publisher.setChargedEnergy(machine.chargedKwh + slotKwh);
      }
    }
    updateState().catch((err) => log(`CarPowerChange error: ${String(err)}`));
  });

  const unsubHold = session.holdSource?.subscribe((held) => {
    heatingHold = held;
    updateState().catch((err) => log(`HeatingHoldChange error: ${String(err)}`));
  });

  try {
    // Main loop: fetch plan, sleep to slot, charge, repeat until target kWh reached.
    while (true) {
      // 1. Check for target time change
      const newTargetTime = getTargetTimeFromPublisher();
      if (newTargetTime.getTime() !== targetTime.getTime()) {
        targetTime = newTargetTime;
        forecast = null;
      }

      // 1b. Check for target kWh change
      const newTargetKwh = getEffectiveTargetKwh();
      if (newTargetKwh !== targetKwh) {
        targetKwh = newTargetKwh;
        forecast = null;
      }

      // 2. Check if target time reached
      if (clock.now() >= env().targetTime) {
        const remaining = targetKwh - machine.chargedKwh;
        let msg: string;
        if (remaining <= 0) {
          msg = `Target time passed - session complete. ${machine.chargedKwh.toFixed(2)} kWh delivered.`;
        } else if (chargeLevelPct === 100) {
          msg = `Target time passed - goal not reached but battery is full. Charged ${machine.chargedKwh.toFixed(2)} / ${targetKwh.toFixed(2)} kWh.`;
        } else {
          msg = `Target time passed - goal not reached. Charged ${machine.chargedKwh.toFixed(2)} / ${targetKwh.toFixed(2)} kWh (${remaining.toFixed(2)} kWh short).`;
        }
        log(msg);
        break;
      }

      // 3. Fetch forecasts if not already fetched
      if (!forecast) {
        try {
          forecast = await fetchPlanInputs(clock.now(), targetTime, config);
        } catch (err) {
          if (err instanceof IncompleteDataError) {
            log(`Forecast unavailable: ${err.message} - retrying at next slot`);
            const msToNextSlot = slotMs - (clock.now().getTime() % slotMs);
            wakeCancel = new Canceller();
            wakeRef.cancel = wakeCancel;
            publisher.setWakeCallback(() => wakeCancel.abort());
            await clock.sleep(msToNextSlot, wakeCancel.signal);
            tracker?.tick(clock.now());
            if (wakeCancel.signal.aborted) {
              if (chargeLevelTriggeredReplan) {
                chargeLevelTriggeredReplan = false;
              } else {
                log("Target time changed during forecast-unavailable wait - re-planning.");
              }
            }
            continue;
          }
          throw err;
        }
        await updateState();
      }

      // 4. Wait for the current slot to end, with events and power tracking
      const planSlots = machine.plan ?? [];
      const currentSlot = planSlots.find((s) => s.end > clock.now());
      if (currentSlot) {
        const chargingInThisSlot = getState(machine.id).relayOn;
        slotMeterStartKwh = latestEnergyKwh; // record meter reference before slot starts

        await updateState();

        const msUntilEnd = Math.max(0, currentSlot.end.getTime() - clock.now().getTime());
        wakeCancel = new Canceller();
        wakeRef.cancel = wakeCancel;
        publisher.setWakeCallback(() => wakeCancel.abort());

        // This is where we wait for the slot to end
        await clock.sleep(msUntilEnd, wakeCancel.signal);
        tracker?.tick(clock.now());

        if (wakeCancel.signal.aborted) {
          if (chargeLevelTriggeredReplan) {
            chargeLevelTriggeredReplan = false;
            // forecast already null, set by the charge level callback
          } else {
            forecast = null;
            log("Target time changed mid-slot - re-planning.");
          }
          continue;
        }

        const slotKwh =
          slotMeterStartKwh !== undefined && latestEnergyKwh !== undefined
            ? Math.max(0, latestEnergyKwh - slotMeterStartKwh)
            : machine.detectedChargerPowerKw * 0.25;

        if (chargingInThisSlot) {
          totalCostEur += currentSlot.effectiveCostEur;
          solarFractionSum +=
            powerKw > 0 ? Math.min(1, currentSlot.solarForecastW / (powerKw * 1000)) : 0;
          chargedSlots += 1;
          machine = {
            ...machine,
            chargedKwh: machine.chargedKwh + slotKwh,
          };
          if (machine.chargedKwh >= targetKwh) {
            log(`Charging complete: ${machine.chargedKwh.toFixed(2)} kWh delivered.`);
            await updateState(); // publish final chargedKwh before exiting
            break;
          }
        }
        await updateState();
      } else {
        // Nothing to do. Let's just sleep for a second.
        await clock.sleep(1000, wakeCancel.signal);
        tracker?.tick(clock.now());
      }
    } // end while(true)

    // After the session loop exits, keep the relay ON and wait until current
    // power drops below the threshold. This guarantees the next WaitingForCar
    // session starts from a clean slate — no stale high-power MQTT readings
    // can slip through and cause a false car-detected transition.
    // (When the battery is full the charger naturally stops drawing power, so
    //  this wait is typically instantaneous. If power stays high beyond the
    //  timeout we start the next session immediately — acceptable for the
    //  target-time-reached-while-charging case.)
    const POWER_DOWN_TIMEOUT_MS = 30_000;
    const powerDownStart = clock.now();
    while (currentPowerW > powerThresholdW) {
      if (clock.now().getTime() - powerDownStart.getTime() >= POWER_DOWN_TIMEOUT_MS) {
        log("Power still high after session end - starting next session immediately.");
        break;
      }
      await clock.sleep(1_000);
      tracker?.tick(clock.now());
    }
  } finally {
    unsubWatts?.();
    unsubHold?.();
    unsubChargeLevel?.();
  }

  publisher.setStatus("Idle");
  publisher.clearPlan();
  publisher.resetTargetTime(clock.now());
  publisher.resetTargetKwh();
  const solarPct = chargedSlots > 0 ? Math.round((solarFractionSum / chargedSlots) * 100) : 0;
  await onSessionEnd?.({
    chargedKwh: machine.chargedKwh,
    plannedKwh: getAdjustedTargetKwh(),
    totalCostEur,
    solarPct,
  });
}
