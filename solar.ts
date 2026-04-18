import { CONFIG } from "./config.ts";
import { readCache, writeCache } from "./cache.ts";
import { log } from "./utils.ts";
import { fetchSolarForecastOpenMeteo } from "./solar-openmeteo.ts";

interface ForecastSolarResult {
  watts: Record<string, number>;
  watt_hours_period: Record<string, number>;
}

export async function fetchSolarForecast(date: string): Promise<Map<number, number>> {
  const cached = readCache<Record<string, number>>(`.solar-cache-${date}.json`);
  if (cached) {
    const map = new Map(Object.entries(cached).map(([k, v]) => [new Date(k).getTime(), v]));
    log(`  Solar forecast loaded from cache (${map.size} slots)`);
    return map;
  }

  const { lat, lon, declination, azimuth, kwp } = CONFIG.solar;
  const url = `https://api.forecast.solar/estimate/${lat}/${lon}/${declination}/${azimuth}/${kwp}`;
  log("Fetching solar forecast from forecast.solar...");
  const res = await fetch(url);
  if (!res.ok) {
    log(`  forecast.solar HTTP ${res.status} — falling back to Open-Meteo`);
    return fetchSolarForecastOpenMeteo();
  }
  const json = (await res.json()) as { result: ForecastSolarResult };

  const watts = json.result.watts;
  const map = new Map<number, number>();
  for (const [tsStr, w] of Object.entries(watts)) {
    map.set(new Date(tsStr.replace(" ", "T")).getTime(), w * CONFIG.solar.efficiencyFactor);
  }
  log(`  Got ${map.size} solar forecast slots`);
  return map;
}

export function persistSolarCache(map: Map<number, number>, date: string): void {
  writeCache(`.solar-cache-${date}.json`, Object.fromEntries(
    [...map.entries()].map(([k, v]) => [new Date(k).toISOString(), v])
  ));
  log("  Solar forecast cached.");
}
