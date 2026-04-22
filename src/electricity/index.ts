import type { PricedSlot } from "./types.ts";
import { fetchSpotPrices, persistSpotCache } from "./spot.ts";
import { fetchSolarForecast, persistSolarCache, lookupSolarW, treeShadingFactor } from "./solar.ts";
import { datesInRange, slotsBetween } from "./dates.ts";
import { log } from "../utils/log.ts";
import { assertNotNull } from "../utils/assertNotNull.ts";
import { IncompleteDataError } from "./IncompleteDataError.ts";
import { type ElectricityConfig, type SolarConfig } from "./config.ts";

export type { PricedSlot } from "./types.ts";

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
  electicity: ElectricityConfig,
  solar: SolarConfig,
): Promise<PricedSlot[]> {
  const slotStarts = slotsBetween(from, to);
  const dates = datesInRange(from, to);

  const [spotMap, solarMap] = await Promise.all([
    fetchSpotPrices(dates),
    fetchSolarForecast(dates, solar),
  ]);

  const missingSpot = slotStarts.filter((s) => !spotMap.has(s.getTime()));
  if (missingSpot.length > 0) {
    throw new IncompleteDataError(
      `Cannot plan safely — missing ${missingSpot.length} spot price slot(s)`,
      missingSpot,
    );
  }
  persistSpotCache(spotMap);

  const solarEpochsDesc = [...solarMap.keys()].sort((a, b) => b - a);
  const missingSolar = slotStarts.filter((s) => !solarMap.has(s.getTime())).length;
  if (missingSolar > 0)
    log(`  ${missingSolar} solar slots without exact match — using nearest preceding value`);
  persistSolarCache(solarMap);

  return slotStarts.map((start) => {
    const epoch = start.getTime();
    const spotPriceEurPerKwh = assertNotNull(
      spotMap.get(epoch),
      `spot price @ ${start.toISOString()}`,
    );
    const rawSolarW = lookupSolarW(epoch, solarMap, solarEpochsDesc);
    const solarForecastW = rawSolarW * treeShadingFactor(start, solar.treeShadingSchedule);
    return {
      start,
      end: new Date(epoch + 15 * 60 * 1000),
      spotPriceEurPerKwh,
      transportCostEurPerKwh: electicity.transportCostEurKwh,
      solarForecastW,
    };
  });
}
