import type { Slot } from "./types.ts";
import type { MachineState, Environment } from "./state-machine.ts";
import type { PricedSlot } from "../electricity/types.ts";
import type { WeeklySchedule } from "./config.ts";

const SLOT_MS = 15 * 60 * 1000;

const DOW_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

function dowKey(d: Date): keyof WeeklySchedule {
  return DOW_KEYS[d.getDay()];
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

export function resolveTargetTime(
  globalTime: string,
  schedule: WeeklySchedule | undefined,
  from: Date,
): Date {
  const todayTime = schedule?.[dowKey(from)] ?? globalTime;
  const [th, tm] = todayTime.split(":").map(Number);
  const todayAt = new Date(from);
  todayAt.setHours(th, tm, 0, 0);
  if (todayAt > from) return todayAt;

  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowTime = schedule?.[dowKey(tomorrow)] ?? globalTime;
  const [tmh, tmm] = tomorrowTime.split(":").map(Number);
  tomorrow.setHours(tmh, tmm, 0, 0);
  return tomorrow;
}

export function formatHHMM(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/**
 * Normalize an MQTT time payload (HH:MM or HH:MM:SS) to zero-padded HH:MM.
 * Returns null for anything that is not a valid clock time.
 */
export function normalizeTimePayload(payload: string): string | null {
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(payload.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  const sec = m[3] !== undefined ? Number(m[3]) : 0;
  if (h > 23 || min > 59 || sec > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

export function floorToSlotStart(date: Date): Date {
  const slot = new Date(date);
  slot.setMinutes(Math.floor(slot.getMinutes() / 15) * 15, 0, 0);
  return slot;
}

export function canWait(machine: MachineState, env: Environment): boolean {
  const remainingKwh = Math.max(0, env.targetKwh - machine.chargedKwh);
  if (remainingKwh === 0) return true;
  if (machine.detectedChargerPowerKw <= 0) return false;

  const from = floorToSlotStart(env.now);
  const remainingSlots = Math.max(
    0,
    Math.floor((env.targetTime.getTime() - from.getTime()) / SLOT_MS),
  );
  const deliverableKwh = remainingSlots * 0.25 * machine.detectedChargerPowerKw;
  return deliverableKwh >= remainingKwh;
}

export function findCurrentPlannedSlot(
  plan: Slot[] | null,
  currentSlotStart: Date | null,
): Slot | null {
  if (!plan || !currentSlotStart) return null;
  const at = currentSlotStart.getTime();
  return plan.find((slot) => slot.start.getTime() === at) ?? null;
}

export function findPlannedSlotAtTime(plan: Slot[] | null, at: Date): Slot | null {
  if (!plan) return null;
  const ts = at.getTime();
  return plan.find((slot) => slot.start.getTime() <= ts && slot.end.getTime() > ts) ?? null;
}

export function findCurrentForecastSlot(
  forecast: PricedSlot[] | null,
  currentSlotStart: Date | null,
): PricedSlot | null {
  if (!forecast || !currentSlotStart) return null;
  const at = currentSlotStart.getTime();
  return forecast.find((slot) => slot.start.getTime() === at) ?? null;
}

export function hasFutureChargeSlot(plan: Slot[] | null, currentSlotStart: Date | null): boolean {
  if (!plan) return false;
  const current = currentSlotStart?.getTime() ?? Number.NEGATIVE_INFINITY;
  return plan.some((slot) => slot.charge && slot.end.getTime() > current);
}

export function nextChargeSlotStart(plan: Slot[] | null, after: Date | null): Date | null {
  if (!plan) return null;
  const afterTs = after?.getTime() ?? Number.NEGATIVE_INFINITY;
  const next = plan.find((slot) => slot.charge && slot.start.getTime() > afterTs);
  return next?.start ?? null;
}

export function findChargeRunEnd(plan: Slot[] | null, currentSlotStart: Date | null): Date | null {
  if (!plan || !currentSlotStart) return null;
  const at = currentSlotStart.getTime();
  const idx = plan.findIndex((slot) => slot.start.getTime() === at && slot.charge);
  if (idx < 0) return null;
  let runEnd = plan[idx].end;
  for (let i = idx + 1; i < plan.length && plan[i].charge; i++) {
    runEnd = plan[i].end;
  }
  return runEnd;
}

export function planChargeStatesChanged(prev: Slot[] | null, next: Slot[]): boolean {
  if (!prev) return true;
  const prevMap = new Map(prev.map((s) => [s.start.getTime(), s.charge]));
  return next.some((s) => {
    const prevCharge = prevMap.get(s.start.getTime());
    return prevCharge === undefined || prevCharge !== s.charge;
  });
}

export function isCurrentSlotSolarFree(machine: MachineState, env: Environment): boolean {
  const slot = findCurrentForecastSlot(env.forecast, floorToSlotStart(env.now));
  if (!slot || machine.detectedChargerPowerKw <= 0) return false;
  const gridFraction =
    Math.max(0, machine.detectedChargerPowerKw - slot.solarForecastW / 1000) /
    machine.detectedChargerPowerKw;
  return gridFraction === 0;
}
