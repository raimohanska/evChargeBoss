import type { PricedSlot } from "./types.ts";
import { fetchSpotPrices, persistSpotCache } from "./spot.ts";
import { fetchSolarForecast, persistSolarCache, lookupSolarW, treeShadingFactor } from "./solar.ts";
import { datesInRange, slotsBetween } from "./dates.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("electricity");
import { assertNotNull } from "../utils/assertNotNull.ts";
import { IncompleteDataError } from "./IncompleteDataError.ts";
import { type ElectricityConfig, type SolarConfig } from "./config.ts";
import type { InfluxConfig } from "../influx.ts";
import { writeLine, escapeTagKeyValue } from "../influx.ts";

export type { PricedSlot } from "./types.ts";

function buildTagStr(tags?: Record<string, string>): string {
  if (!tags || Object.keys(tags).length === 0) return "";
  return (
    "," +
    Object.entries(tags)
      .map(([k, v]) => `${escapeTagKeyValue(k)}=${escapeTagKeyValue(v)}`)
      .join(",")
  );
}

/**
 * Fetch spot prices and solar forecast for every 15-minute slot between
 * `from` (inclusive) and `to` (exclusive), apply caching, and return the
 * enriched slots.  The returned slots contain the raw spot price, the
 * configured transport cost, and the shade-corrected solar estimate.
 * Charging decisions (effectiveCostEur, charge flag) are left to the caller.
 *
 * If `influxConfig` is provided and the respective `electricity.influx` /
 * `solar.influx` measurement configs are present, freshly fetched data
 * (i.e. not served from cache) is written to InfluxDB.
 */
export async function fetchSlots(
  from: Date,
  to: Date,
  electicity: ElectricityConfig,
  solar: SolarConfig,
  verbose?: boolean,
  influxConfig?: InfluxConfig,
): Promise<PricedSlot[]> {
  const slotStarts = slotsBetween(from, to);
  const dates = datesInRange(from, to);

  const [{ map: spotMap, fresh: spotFresh }, { map: solarMap, fresh: solarFresh }] =
    await Promise.all([fetchSpotPrices(dates, verbose), fetchSolarForecast(dates, solar, verbose)]);

  const missingSpot = slotStarts.filter((s) => !spotMap.has(s.getTime()));
  if (missingSpot.length > 0) {
    throw new IncompleteDataError(
      `Cannot plan safely — missing ${missingSpot.length} spot price slot(s)`,
      missingSpot,
    );
  }
  persistSpotCache(spotMap, verbose);

  const solarEpochsDesc = [...solarMap.keys()].sort((a, b) => b - a);
  const missingSolar = slotStarts.filter((s) => !solarMap.has(s.getTime())).length;
  if (missingSolar > 0 && verbose)
    log(`  ${missingSolar} solar slots without exact match — using nearest preceding value`);
  persistSolarCache(solarMap, verbose);

  const slots = slotStarts.map((start) => {
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

  if (influxConfig) {
    if (spotFresh && electicity.influx) {
      const tagStr = buildTagStr({ ...influxConfig.tags, ...electicity.influx.tags });
      const measurement = escapeTagKeyValue(electicity.influx.measurement);
      const body = slots
        .map((s) => `${measurement}${tagStr} value=${s.spotPriceEurPerKwh} ${s.start.getTime()}`)
        .join("\n");
      writeLine(influxConfig, body).catch((e: Error) =>
        log(`[Influx] electricity forecast write failed: ${e.message}`),
      );
    }
    if (solarFresh && solar.influx) {
      const tagStr = buildTagStr({ ...influxConfig.tags, ...solar.influx.tags });
      const measurement = escapeTagKeyValue(solar.influx.measurement);
      const body = slots
        .map((s) => `${measurement}${tagStr} value=${s.solarForecastW} ${s.start.getTime()}`)
        .join("\n");
      writeLine(influxConfig, body).catch((e: Error) =>
        log(`[Influx] solar forecast write failed: ${e.message}`),
      );
    }
  }

  return slots;
}
