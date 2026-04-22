import type { FetchSlotsConfig, PricedSlot, SolarConfig } from "./types.ts";
import { fetchSpotPrices, persistSpotCache } from "./spot.ts";
import { fetchSolarForecast, persistSolarCache } from "./solar.ts";
import { log, assertNotNull, localDateString } from "../utils.ts";
import { IncompleteDataError } from "../errors.ts";

export type { FetchSlotsConfig, PricedSlot, SolarConfig } from "./types.ts";

function datesInRange(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (d <= end) {
    dates.push(localDateString(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function slotsBetween(from: Date, to: Date): Date[] {
  const slots: Date[] = [];
  const t = new Date(from);
  // align to current 15-min boundary (floor) so the ongoing slot is included
  t.setMinutes(Math.floor(t.getMinutes() / 15) * 15, 0, 0);
  while (t < to) {
    slots.push(new Date(t));
    t.setMinutes(t.getMinutes() + 15);
  }
  return slots;
}

function treeShadingFactor(date: Date, schedule: SolarConfig["treeShadingSchedule"]): number {
  const minutesOfDay = date.getHours() * 60 + date.getMinutes();
  const points = schedule.map(({ time, outputFraction }) => {
    const [h, m] = time.split(":").map(Number);
    return { minutes: h * 60 + m, outputFraction };
  });

  if (minutesOfDay <= points[0].minutes) return 1.0;
  if (minutesOfDay >= points[points.length - 1].minutes)
    return points[points.length - 1].outputFraction;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i],
      b = points[i + 1];
    if (minutesOfDay >= a.minutes && minutesOfDay < b.minutes) {
      const t = (minutesOfDay - a.minutes) / (b.minutes - a.minutes);
      return a.outputFraction + t * (b.outputFraction - a.outputFraction);
    }
  }
  return 1.0;
}

/**
 * Fetch spot prices and solar forecast for every 15-minute slot between
 * `from` (inclusive) and `to` (exclusive), apply caching, and return the
 * enriched slots.  The returned slots contain the raw spot price, the
 * configured transport cost, and the shade-corrected solar estimate.
 * Charging decisions (effectiveCostEur, charge flag) are left to the caller.
 */
export async function fetchSlots(
  from: Date,
  to: Date,
  config: FetchSlotsConfig,
): Promise<PricedSlot[]> {
  const slotStarts = slotsBetween(from, to);
  const dates = datesInRange(from, to);

  const [spotMap, solarMap] = await Promise.all([
    fetchSpotPrices(dates),
    fetchSolarForecast(dates, config.solar),
  ]);

  const missingSpot = slotStarts.filter((s) => !spotMap.has(s.getTime()));
  if (missingSpot.length > 0) {
    throw new IncompleteDataError(
      `Cannot plan safely — missing ${missingSpot.length} spot price slot(s)`,
      missingSpot,
    );
  }
  persistSpotCache(spotMap);

  // Build a sorted list of solar epochs for nearest-preceding lookup.
  // The reversed copy is also pre-built here so the .find() inside the
  // per-slot map below does not allocate a new array for every slot.
  const solarEpochs = [...solarMap.keys()].sort((a, b) => a - b);
  const solarEpochsReversed = [...solarEpochs].reverse();

  const missingSolar = slotStarts.filter((s) => !solarMap.has(s.getTime())).length;
  if (missingSolar > 0)
    log(`  ${missingSolar} solar slots without exact match — using nearest preceding value`);
  persistSolarCache(solarMap);

  return slotStarts.map((start) => {
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const epoch = start.getTime();

    const spotPriceEurPerKwh = assertNotNull(
      spotMap.get(epoch),
      `spot price @ ${start.toISOString()}`,
    );
    const rawSolarW =
      solarMap.get(epoch) ?? solarMap.get(solarEpochsReversed.find((k) => k <= epoch) ?? -1) ?? 0;
    const solarForecastW = rawSolarW * treeShadingFactor(start, config.solar.treeShadingSchedule);

    return {
      start,
      end,
      spotPriceEurPerKwh,
      transportCostEurPerKwh: config.transportCostEurKwh,
      solarForecastW,
    };
  });
}
