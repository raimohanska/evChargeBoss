import { readCache, writeCache } from "./cache.ts";
import { log, localDateString, localDateTimeString } from "./utils.ts";

const CACHE_DIR = process.env.CACHE_DIR ?? ".";

interface SpotHintaEntry {
  Rank: number;
  DateTime: string;
  PriceNoTax: number;
  PriceWithTax: number; // €/kWh incl. VAT
}

export async function fetchSpotPrices(dates: string[]): Promise<Map<number, number>> {
  const missingDates = dates.filter((d) => readCache(`${CACHE_DIR}/.spot-cache-${d}.json`) === null);

  if (missingDates.length > 0) {
    log(`Fetching spot prices from api.spot-hinta.fi... (missing: ${missingDates.join(", ")})`);
    const res = await fetch("https://api.spot-hinta.fi/TodayAndDayForward");
    if (!res.ok) throw new Error(`spot-hinta.fi HTTP ${res.status}`);
    const data = (await res.json()) as SpotHintaEntry[];
    const map = new Map<number, number>();
    for (const entry of data) {
      map.set(new Date(entry.DateTime).getTime(), entry.PriceWithTax);
    }
    log(`  Got ${map.size} quarter-hour price slots`);
    return map;
  }

  const map = new Map<number, number>();
  for (const date of dates) {
    const cached = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-${date}.json`)!;
    for (const [k, v] of Object.entries(cached)) {
      map.set(new Date(k).getTime(), v);
    }
  }
  log(`  Spot prices loaded from cache (${map.size} slots)`);
  return map;
}

export function persistSpotCache(map: Map<number, number>): void {
  const byDate = new Map<string, Record<string, number>>();
  for (const [epoch, price] of map) {
    const date = localDateString(new Date(epoch));
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)![localDateTimeString(new Date(epoch))] = price;
  }
  for (const [date, data] of byDate) {
    writeCache(`${CACHE_DIR}/.spot-cache-${date}.json`, data);
  }
  log(`  Spot prices cached (${byDate.size} day file(s)).`);
}
