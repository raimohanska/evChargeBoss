import type { Config } from "../config.ts";
import type { SessionSummary } from "../influx.ts";
import type { StatusPublisher } from "./mqtt-status.ts";
import type { ChargingSession } from "./charger.ts";
import type { Clock } from "../utils/timing-utils.ts";
import type { Environment, MachineState, StateId } from "./state-machine.ts";
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
import { type PricedSlot } from "../electricity/types.ts";
const log = makeLogger("ev-charging");

const EvChargingPlanSchema = z.object({
  version: z.literal(1),
  detectedPowerKw: z.number(),
  chargedKwh: z.number(),
  config: z.object({
    targetKwh: z.number(),
    targetDateTime: z.string(),
  }),
});

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

function getInitialState(config: Config, targetTime: Date): MachineState {
  // Try to resume from a persisted plan file.
  const planPath = findNewestPlanFile("ev-charging");
  if (planPath) {
    const saved = readPlanFile(planPath, EvChargingPlanSchema);
    if (
      saved &&
      saved.config.targetKwh === config.evCharging.targetKwh &&
      new Date(saved.config.targetDateTime).getTime() === targetTime.getTime() &&
      saved.chargedKwh < config.evCharging.targetKwh
    ) {
      log(`Resuming: chargedKwh=${saved.chargedKwh}, detectedPowerKw=${saved.detectedPowerKw}`);
      return {
        plan: null,
        id: "Planning",
        chargedKwh: saved.chargedKwh,
        detectedChargerPowerKw: saved.detectedPowerKw,
      };
    } else {
      let reason: string;
      if (!saved) {
        reason = "plan file unreadable";
      } else if (saved.config.targetKwh !== config.evCharging.targetKwh) {
        reason = `targetKwh mismatch: saved=${saved.config.targetKwh}, config=${config.evCharging.targetKwh}`;
      } else if (new Date(saved.config.targetDateTime).getTime() !== targetTime.getTime()) {
        reason = `targetDateTime mismatch: saved=${saved.config.targetDateTime}, config=${localDateTimeString(targetTime)}`;
      } else {
        reason = `session already complete: chargedKwh=${saved.chargedKwh} >= targetKwh=${config.evCharging.targetKwh}`;
      }
      log(`Plan file found but not applicable (${planPath}): ${reason} — starting fresh.`);
    }
  }

  return {
    id: "WaitingForCar",
    plan: null,
    chargedKwh: 0,
    detectedChargerPowerKw: config.evCharging.powerKw ?? 0,
  };
}

export async function runSession(
  session: ChargingSession,
  publisher: StatusPublisher,
  config: Config,
  from: Date | undefined,
  clock: Clock,
  onSessionEnd?: (summary: SessionSummary) => Promise<void>,
): Promise<void> {
  const now = from ?? clock.now();
  const powerThresholdW = config.evCharging.mqtt?.powerThresholdW ?? 10;
  const powerKw = config.evCharging.powerKw ?? 0;
  const slotMs = 15 * 60 * 1000;

  const getTargetTimeFromPublisher = () => {
    const targetTimeStr = publisher.getTargetTimeOverride() ?? config.evCharging.targetTime;
    return parseTargetTime(targetTimeStr, now);
  };

  let targetTime = getTargetTimeFromPublisher();
  let currentPowerW = 0;
  let heatingHold = false;
  let relayOn: boolean | null = null;
  let totalCostEur = 0;
  let solarFractionSum = 0;
  let chargedSlots = 0;
  let forecast: PricedSlot[] | null = null;

  let machine: MachineState = getInitialState(config, targetTime);

  const savePlan = () => {
    const filePath = planFilePath("ev-charging", timestampForFilename(now));
    writePlanFile(filePath, {
      version: 1,
      detectedPowerKw: machine.detectedChargerPowerKw,
      chargedKwh: machine.chargedKwh,
      config: {
        targetKwh: config.evCharging.targetKwh,
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
    targetKwh: config.evCharging.targetKwh,
  });

  const updateState = async () => {
    machine = nextState(machine, env());
    savePlan();
    await publishState();
  };

  const publishState = async () => {
    publisher.setStatus(getStatus(machine, env()));
    publisher.setChargedEnergy(machine.chargedKwh);
    const want = getState(machine.id).relayOn;
    if (want === relayOn) return;
    relayOn = want;
    await session.driver.send(relayOn);
  };
  await publishState();

  let wakeCancel = new Canceller();
  publisher.setWakeCallback(() => wakeCancel.abort());

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

      // 2. Check if target time reached
      if (clock.now() >= env().targetTime) {
        log("Target time passed — session complete.");
        break;
      }

      // 3. Fetch forecasts if not already fetched
      if (!forecast) {
        try {
          forecast = await fetchPlanInputs(clock.now(), targetTime, config);
        } catch (err) {
          if (err instanceof IncompleteDataError) {
            log(`Forecast unavailable: ${err.message} — retrying at next slot`);
            const msToNextSlot = slotMs - (clock.now().getTime() % slotMs);
            wakeCancel = new Canceller();
            publisher.setWakeCallback(() => wakeCancel.abort());
            await clock.sleep(msToNextSlot, wakeCancel.signal);
            if (wakeCancel.signal.aborted) {
              log("Target time changed during forecast-unavailable wait — re-planning.");
            }
            continue;
          }
          throw err;
        }
        await updateState();
      }

      // 4. Publish current plan to publisher
      const planSlots = machine.plan ?? [];
      if (planSlots.length > 0) publisher.setPlan(planSlots);

      // 5. Wait for the current slot to end, with events and power tracking
      const currentSlot = planSlots.find((s) => s.end > clock.now());
      if (currentSlot) {
        const chargingInThisSlot = getState(machine.id).relayOn;
        slotMeterStartKwh = latestEnergyKwh; // record meter reference before slot starts

        await updateState();

        const msUntilEnd = Math.max(0, currentSlot.end.getTime() - clock.now().getTime());
        wakeCancel = new Canceller();
        publisher.setWakeCallback(() => wakeCancel.abort());

        // This is where we wait for the slot to end
        await clock.sleep(msUntilEnd, wakeCancel.signal);

        if (wakeCancel.signal.aborted) {
          forecast = null;
          log("Target time changed mid-slot — re-planning.");
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
          if (machine.chargedKwh >= config.evCharging.targetKwh) {
            log(`Charging complete: ${machine.chargedKwh.toFixed(2)} kWh delivered.`);
            break;
          }
        }
        await updateState();
      } else {
        // Nothing to do. Let's just sleep for a second.
        await clock.sleep(1000, wakeCancel.signal);
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
        log("Power still high after session end — starting next session immediately.");
        break;
      }
      await clock.sleep(1_000);
    }
  } finally {
    unsubWatts?.();
    unsubHold?.();
  }

  publisher.setStatus("Idle");
  publisher.resetTargetTime();
  const solarPct = chargedSlots > 0 ? Math.round((solarFractionSum / chargedSlots) * 100) : 0;
  await onSessionEnd?.({ chargedKwh: machine.chargedKwh, totalCostEur, solarPct });
}
