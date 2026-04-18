import { CONFIG } from "./config.ts";
import { readCache, writeCache } from "./cache.ts";
import { log } from "./utils.ts";
import { fetchSolarForecastOpenMeteo } from "./solar-openmeteo.ts";

interface ForecastSolarResult {
  watts: Record<string, number>;
  watt_hours_period: Record<string, number>;
}

export async function fetchSolarForecast(dates: string[]): Promise<Map<number, number>> {
  const missingDates = dates.filter((d) => readCache(`.solar-cache-${d}.json`) === null);

  if (missingDates.length > 0) {
    log(`Fetching solar forecast... (missing: ${missingDates.join(", ")})`);
    const { lat, lon, declination, azimuth, kwp } = CONFIG.solar;
    const url = `https://api.forecast.solar/estimate/${lat}/${lon}/${declination}/${azimuth}/${kwp}`;
    log("Fetching solar forecast from forecast.solar...");
    const res = await fetch(url);
    if (!res.ok) {
      log(`  forecast.solar HTTP ${res.status} — falling back to Open-Meteo`);
      return fetchSolarForecastOpenMeteo();
    }
    const json = (await res.json()) as { result: ForecastSolarResult };
    const map = new Map<number, number>();
    for (const [tsStr, w] of Object.entries(json.result.watts)) {
      map.set(new Date(tsStr.replace(" ", "T")).getTime(), w * CONFIG.solar.efficiencyFactor);
    }
    log(`  Got ${map.size} solar forecast slots`);
    return map;
  }

  const map = new Map<number, number>();
  for (const date of dates) {
    const cached = readCache<Record<string, number>>(`.solar-cache-${date}.json`)!;
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
    const date = new Date(epoch).toLocaleDateString("sv-SE");
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)![new Date(epoch).toISOString()] = watts;
  }
  for (const [date, data] of byDate) {
    writeCache(`.solar-cache-${date}.json`, data);
  }
  log(`  Solar forecast cached (${byDate.size} day file(s)).`);
}
