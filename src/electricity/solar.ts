import type { SolarConfig } from "./config.ts";
import { readCache, writeCache } from "./cache.ts";
import { localDateString, localDateTimeString } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";
import { fetchSolarForecastOpenMeteo } from "./solar-openmeteo.ts";

const CACHE_DIR = process.env.CACHE_DIR ?? ".";

interface ForecastSolarResult {
  watts: Record<string, number>;
  watt_hours_period: Record<string, number>;
}

export async function fetchSolarForecast(
  dates: string[],
  solarConfig: SolarConfig,
): Promise<Map<number, number>> {
  const missingDates = dates.filter(
    (d) => readCache(`${CACHE_DIR}/.solar-cache-${d}.json`) === null,
  );

  if (missingDates.length > 0) {
    log(`Fetching solar forecast... (missing: ${missingDates.join(", ")})`);
    const { lat, lon, declination, azimuth, kwp } = solarConfig;
    const url = `https://api.forecast.solar/estimate/${lat}/${lon}/${declination}/${azimuth}/${kwp}`;
    log("Fetching solar forecast from " + url);
    const res = await fetch(url);
    if (!res.ok) {
      log(`  forecast.solar HTTP ${res.status} — falling back to Open-Meteo`);
      return fetchSolarForecastOpenMeteo(solarConfig);
    }
    const json = (await res.json()) as { result: ForecastSolarResult };
    const map = new Map<number, number>();
    for (const [tsStr, w] of Object.entries(json.result.watts)) {
      map.set(new Date(tsStr.replace(" ", "T")).getTime(), w);
    }
    log(`  Got ${map.size} solar forecast slots`);
    return map;
  }

  const map = new Map<number, number>();
  for (const date of dates) {
    const cached = readCache<Record<string, number>>(`${CACHE_DIR}/.solar-cache-${date}.json`)!;
    for (const [k, v] of Object.entries(cached)) {
      map.set(new Date(k).getTime(), v);
    }
  }
  log(`  Solar forecast loaded from cache (${map.size} slots)`);
  return map;
}

export function persistSolarCache(map: Map<number, number>): void {
  const byDate = new Map<string, Record<string, number>>();
  for (const [epoch, watts] of map) {
    const date = localDateString(new Date(epoch));
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)![localDateTimeString(new Date(epoch))] = watts;
  }
  for (const [date, data] of byDate) {
    writeCache(`${CACHE_DIR}/.solar-cache-${date}.json`, data);
  }
  log(`  Solar forecast cached (${byDate.size} day file(s)).`);
}

/**
 * Return the watt value for `epoch` from the solar map, falling back to the
 * nearest preceding epoch when there is no exact match.
 * `solarEpochsDesc` must be the map's keys sorted descending (pre-built by
 * the caller to avoid re-allocating it for every slot).
 */
export function lookupSolarW(
  epoch: number,
  solarMap: Map<number, number>,
  solarEpochsDesc: number[],
): number {
  return solarMap.get(epoch) ?? solarMap.get(solarEpochsDesc.find((k) => k <= epoch) ?? -1) ?? 0;
}

export function treeShadingFactor(
  date: Date,
  schedule: SolarConfig["treeShadingSchedule"],
): number {
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
