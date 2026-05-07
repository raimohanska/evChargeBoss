import type { Config } from "../config.ts";
import type { Slot } from "./types.ts";
import { fetchSlots } from "../electricity/index.ts";
import { localTimeShort, localDateTimeString } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";

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
    verbose,
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
