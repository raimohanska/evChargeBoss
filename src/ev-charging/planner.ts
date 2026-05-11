import type { Config } from "../config.ts";
import type { Slot } from "./types.ts";
import { fetchSlots } from "../electricity/index.ts";
import { fetchSolarForecast, lookupSolarW, treeShadingFactor } from "../electricity/solar.ts";
import { localTimeShort, localDateTimeString, localDateString } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("ev-charging");

export async function plan(
  from: Date,
  targetTime: Date,
  targetKwh: number,
  powerKw: number,
  config: Config,
  verbose?: boolean,
): Promise<Slot[]> {
  const pricedSlots = await fetchSlots(
    from,
    targetTime,
    config.electricity,
    config.solar,
    config.influx,
  );

  if (verbose !== false) {
    log(
      `Planning ${pricedSlots.length} slots from ${localTimeShort(from)} to ${localDateTimeString(targetTime)}`,
    );
  }

  const slots: Slot[] = pricedSlots.map((ps) => {
    // Fraction of charger power not covered by solar (clamped to [0, 1])
    const gridFraction = Math.max(0, powerKw - ps.solarForecastW / 1000) / powerKw;
    return {
      ...ps,
      effectiveCostEur:
        gridFraction * (ps.spotPriceEurPerKwh + ps.transportCostEurPerKwh) * powerKw * 0.25,
      charge: false,
      canHold: false,
    };
  });

  // Select cheapest N slots
  const slotsNeeded = Math.ceil(targetKwh / (powerKw * 0.25)); // 0.25h per slot
  if (verbose !== false)
    log(`Need ${slotsNeeded} slots to deliver ${targetKwh} kWh at ${powerKw} kW`);

  const sorted = [...slots].sort(
    (a, b) => a.effectiveCostEur - b.effectiveCostEur || a.start.getTime() - b.start.getTime(),
  );
  const selected = new Set(sorted.slice(0, slotsNeeded).map((s) => s.start.getTime()));
  slots.forEach((s) => (s.charge = selected.has(s.start.getTime())));

  // Also charge any solar-free slots beyond the required number — these are
  // effectively free and can top up the battery if there is still capacity.
  slots.forEach((s) => {
    if (!s.charge && s.effectiveCostEur === 0) s.charge = true;
  });

  // Compute canHold for each slot: true when skipping this slot entirely still
  // leaves enough future charge slots to reach targetKwh.
  // Each charge slot delivers powerKw * 0.25 kWh; we need ceil(targetKwh /
  // kwhPerSlot) slots minimum.  A slot can be held iff (chargeCount - 1) other
  // slots cover targetKwh — i.e. there is at least one spare slot in the plan.
  const kwhPerSlot = powerKw * 0.25;
  const chargeCount = slots.filter((s) => s.charge).length;
  const spareKwh = (chargeCount - 1) * kwhPerSlot;
  slots.forEach((s) => {
    s.canHold = s.charge && spareKwh >= targetKwh;
  });

  return slots;
}

export type FallbackReason = "solar" | "mustCharge" | "waiting";

export interface FallbackDecision {
  charge: boolean;
  reason: FallbackReason;
  /** Human-readable detail for the first log of this state. */
  details: string;
  /** End of the current 15-minute slot — sleep until this before retrying. */
  slotEnd: Date;
}

/**
 * Per-slot fallback decision used when spot prices are unavailable.
 * Charges for free (solar covers load) or charges when forced (no time left).
 * Otherwise keeps the relay OFF and waits for the next slot.
 */
export async function planFallbackSlot(
  now: Date,
  targetDate: Date,
  remainingKwh: number,
  powerKw: number,
  config: Config,
): Promise<FallbackDecision> {
  // Align to current 15-min slot boundary (floor).
  const slotStart = new Date(now);
  slotStart.setMinutes(Math.floor(slotStart.getMinutes() / 15) * 15, 0, 0);
  const slotEnd = new Date(slotStart.getTime() + 15 * 60 * 1000);

  // Fetch solar for this slot's date (served from cache if available).
  const dateStr = localDateString(slotStart);
  const { map: solarMap } = await fetchSolarForecast([dateStr], config.solar);
  const solarEpochsDesc = [...solarMap.keys()].sort((a, b) => b - a);
  const rawSolarW = lookupSolarW(slotStart.getTime(), solarMap, solarEpochsDesc);
  const effectiveSolarW =
    rawSolarW * treeShadingFactor(slotStart, config.solar.treeShadingSchedule);
  const gridFraction = Math.max(0, powerKw - effectiveSolarW / 1000) / powerKw;

  if (gridFraction === 0) {
    return {
      charge: true,
      reason: "solar",
      details: `Solar covers load (${Math.round(effectiveSolarW)} W) — charging for free`,
      slotEnd,
    };
  }

  // How many 15-min slots remain until target?
  const msToTarget = targetDate.getTime() - now.getTime();
  const slotsToTarget = Math.floor(msToTarget / (15 * 60 * 1000));
  const slotsNeeded = Math.ceil(remainingKwh / (powerKw * 0.25));

  if (slotsToTarget <= slotsNeeded) {
    return {
      charge: true,
      reason: "mustCharge",
      details: `Must charge now — ${slotsToTarget} slot(s) to target, need ${slotsNeeded}`,
      slotEnd,
    };
  }

  return {
    charge: false,
    reason: "waiting",
    details: `Waiting for spot prices — ${slotsToTarget} slot(s) to target, need ${slotsNeeded}`,
    slotEnd,
  };
}
