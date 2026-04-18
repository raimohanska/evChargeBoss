import { CONFIG } from "./config.ts";
import { log } from "./utils.ts";

// Uses Open-Meteo shortwave radiation (horizontal plane) as a PV proxy.
// Less accurate than forecast.solar (no tilt/azimuth correction) but
// free with no rate limits and no API key required.

interface OpenMeteoResponse {
  hourly: {
    time: string[];
    shortwave_radiation: number[];
  };
}

export async function fetchSolarForecastOpenMeteo(): Promise<Map<number, number>> {
  const { lat, lon, kwp } = CONFIG.solar;
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=shortwave_radiation&forecast_days=2&timezone=auto`;
  log("Fetching solar forecast from " + url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
  const json = (await res.json()) as OpenMeteoResponse;

  // Build epoch → watts map from hourly data, expanded to 15-min slots
  const map = new Map<number, number>();
  for (let i = 0; i < json.hourly.time.length; i++) {
    const hourEpoch = new Date(json.hourly.time[i]).getTime();
    const watts = (json.hourly.shortwave_radiation[i] / 1000) * kwp * 1000;
    for (let q = 0; q < 4; q++) {
      map.set(hourEpoch + q * 15 * 60 * 1000, watts);
    }
  }

  log(`  Got ${map.size} solar forecast slots from Open-Meteo`);
  return map;
}
