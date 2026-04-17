import { CONFIG } from "./config.ts";
import { readCache, writeCache } from "./cache.ts";
import { log } from "./utils.ts";

// Uses Open-Meteo shortwave radiation (horizontal plane) as a PV proxy.
// Less accurate than forecast.solar (no tilt/azimuth correction) but
// free with no rate limits and no API key required.

const CACHE_FILE = ".solar-openmeteo-cache.json";

interface OpenMeteoResponse {
  hourly: {
    time: string[];
    shortwave_radiation: number[];
  };
}

export async function fetchSolarForecastOpenMeteo(): Promise<Map<number, number>> {
  const cached = readCache<Record<string, number>>(CACHE_FILE);
  if (cached) {
    const map = new Map(Object.entries(cached).map(([k, v]) => [Number(k), v]));
    log(`  Solar forecast (Open-Meteo) loaded from cache (${map.size} slots)`);
    return map;
  }

  const { lat, lon, kwp, efficiencyFactor } = CONFIG.solar;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&forecast_days=2&timezone=auto`;
  log("Fetching solar forecast from Open-Meteo (backup)...");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
  const json = (await res.json()) as OpenMeteoResponse;

  // Build epoch → watts map from hourly data, expanded to 15-min slots
  const map = new Map<number, number>();
  for (let i = 0; i < json.hourly.time.length; i++) {
    const hourEpoch = new Date(json.hourly.time[i]).getTime();
    const watts = (json.hourly.shortwave_radiation[i] / 1000) * kwp * 1000 * efficiencyFactor;
    for (let q = 0; q < 4; q++) {
      map.set(hourEpoch + q * 15 * 60 * 1000, watts);
    }
  }

  writeCache(CACHE_FILE, Object.fromEntries(map));
  log(`  Got ${map.size} solar forecast slots from Open-Meteo (cached)`);
  return map;
}
