import type { Slot } from "./types.ts";
import { type PricedSlot } from "../electricity/types.ts";
import {
  canWait,
  findChargeRunEnd,
  findCurrentPlannedSlot,
  findPlannedSlotAtTime,
  floorToSlotStart,
  hasFutureChargeSlot,
  isCurrentSlotSolarFree,
  nextChargeSlotStart,
  planChargeStatesChanged,
} from "./helpers.ts";
import { computePlan } from "./planner.ts";
import { makeLogger } from "../utils/log.ts";
import { printPlan } from "./print-plan.ts";
import { localTimeShort } from "../utils/date-time-format.ts";

export { canWait };
const log = makeLogger("ev-charging");

export type StateId =
  | "WaitingForCar"
  | "Planning"
  | "WaitingForChargingStart"
  | "ChargingAsPlanned"
  | "ChargingPausedForHeat"
  | "ForcedToChargingWithoutPlan"
  | "SolarFreeChargingWithoutPlan"
  | "SleepingUntilSlot";

export interface StateHandler {
  readonly id: StateId;
  readonly relayOn: boolean;
  getStatusMessage(machine: MachineState, env: Environment): string;
}

const states: Record<StateId, StateHandler> = {
  WaitingForCar: {
    id: "WaitingForCar",
    relayOn: true,
    getStatusMessage() {
      return "Waiting for car to be plugged in";
    },
  },
  Planning: {
    id: "Planning",
    relayOn: false, // TODO: should stay on!
    getStatusMessage(machine, env) {
      if (machine.plan === null) {
        return "Waiting for data";
      }
      const nextStart = nextChargeSlotStart(machine.plan, floorToSlotStart(env.now));
      return nextStart ? `Planned charge start at ${localTimeShort(nextStart)}` : "Idle";
    },
  },
  WaitingForChargingStart: {
    id: "WaitingForChargingStart",
    relayOn: true,
    getStatusMessage() {
      return "Waiting for charging to start";
    },
  },
  ChargingAsPlanned: {
    id: "ChargingAsPlanned",
    relayOn: true,
    getStatusMessage(machine, env) {
      const runEnd = findChargeRunEnd(machine.plan, floorToSlotStart(env.now));
      return runEnd ? `Charging until ${localTimeShort(runEnd)}` : "Charging";
    },
  },
  ChargingPausedForHeat: {
    id: "ChargingPausedForHeat",
    relayOn: false,
    getStatusMessage() {
      return "Charging paused (heating peak)";
    },
  },
  ForcedToChargingWithoutPlan: {
    id: "ForcedToChargingWithoutPlan",
    relayOn: true,
    getStatusMessage() {
      return "WARNING: Charging while spot prices unavailable";
    },
  },
  SolarFreeChargingWithoutPlan: {
    id: "SolarFreeChargingWithoutPlan",
    relayOn: true,
    getStatusMessage() {
      return "Charging while waiting for spot prices. 100% solar.";
    },
  },
  SleepingUntilSlot: {
    id: "SleepingUntilSlot",
    relayOn: false,
    getStatusMessage(machine, env) {
      const nextStart = nextChargeSlotStart(machine.plan, floorToSlotStart(env.now));
      return nextStart ? `Planned charge start at ${localTimeShort(nextStart)}` : "Idle";
    },
  },
};

export interface MachineState {
  readonly id: StateId;
  readonly plan: Slot[] | null;
  readonly chargedKwh: number;
  readonly detectedChargerPowerKw: number;
  /** true once a live power reading has exceeded the initial configured value */
  readonly powerKwMeasured: boolean;
}

export interface Environment {
  readonly now: Date;
  readonly targetTime: Date;
  readonly currentPowerW: number;
  readonly heatingHold: boolean;
  readonly forecast: PricedSlot[] | null;
  readonly powerThresholdW: number;
  readonly targetKwh: number;
}

export function getState(id: StateId): StateHandler {
  return states[id];
}

export function getStatus(machine: MachineState, env: Environment): string {
  return getState(machine.id).getStatusMessage(machine, env);
}

export function nextState(machine: MachineState, env: Environment): MachineState {
  if (machine.id === "WaitingForCar" && env.currentPowerW <= env.powerThresholdW) {
    return machine;
  }
  if (env.currentPowerW / 1000 > machine.detectedChargerPowerKw) {
    machine = {
      ...machine,
      detectedChargerPowerKw: env.currentPowerW / 1000,
      powerKwMeasured: true,
    };
  }
  if (env.forecast) {
    const remainingKwh = Math.max(0, env.targetKwh - machine.chargedKwh);
    const plan = computePlan(
      env.forecast,
      remainingKwh,
      machine.detectedChargerPowerKw,
      env.targetTime,
      env.now,
    );
    const printOpts = {
      powerKw: machine.detectedChargerPowerKw,
      targetTime: env.targetTime,
      targetKwh: env.targetKwh,
      chargedKwh: machine.chargedKwh,
    };
    if (machine.plan === null) {
      if (machine.powerKwMeasured) {
        log(`Plan computed using measured power ${machine.detectedChargerPowerKw} kW`);
      } else {
        log(
          `Warning: planning with configured power ${machine.detectedChargerPowerKw} kW - no live measurement yet`,
        );
      }
      printPlan(plan, printOpts);
    } else if (planChargeStatesChanged(machine.plan, plan)) {
      log("Plan updated (charge slots changed)");
      printPlan(plan, printOpts);
    }
    machine = {
      ...machine,
      plan,
    };
  } else if (machine.plan) {
    machine = {
      ...machine,
      plan: null,
    };
  }
  if (!machine.plan) {
    if (isCurrentSlotSolarFree(machine, env)) {
      return {
        ...machine,
        id: "SolarFreeChargingWithoutPlan",
      };
    }
    if (canWait(machine, env)) {
      return {
        ...machine,
        id: "Planning",
      };
    }
    // Forced to charge without plan
    return {
      ...machine,
      id: "ForcedToChargingWithoutPlan",
    };
  }
  // We have a plan
  const ref = floorToSlotStart(env.now);
  const slot =
    findCurrentPlannedSlot(machine.plan, ref) ?? findPlannedSlotAtTime(machine.plan, env.now);
  if (slot?.charge) {
    const chargingNow = env.currentPowerW > env.powerThresholdW;

    if (env.heatingHold && canWait(machine, env)) {
      if (canWait(machine, env)) {
        return {
          ...machine,
          id: "ChargingPausedForHeat",
        };
      }
    }
    return {
      ...machine,
      id: chargingNow ? "ChargingAsPlanned" : "WaitingForChargingStart",
    };
  }
  if (hasFutureChargeSlot(machine.plan, floorToSlotStart(env.now))) {
    return { ...machine, id: "SleepingUntilSlot" };
  }
  return { ...machine, id: "Planning" };
}
