import type { Config } from "../config.ts";
import type { Slot } from "./types.ts";
import { fetchSlots } from "../electricity/index.ts";
import { localTimeShort, localDateTimeString } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";

export async function plan(
  from: Date,
  targetTime: Date,
  targetKwh: number,
  config: Config,
  verbose?: boolean,
): Promise<Slot[]> {
  const { powerKw } = config.evCharging;

  const pricedSlots = await fetchSlots(from, targetTime, config.electricity, config.solar, verbose);

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

  return slots;
}
