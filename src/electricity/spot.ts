import { readCache, writeCache } from "./cache.ts";
import { localDateString, localDateTimeString } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";
import { fetchSpotPricesElering } from "./spot-elering.ts";

const log = makeLogger("electricity");

const CACHE_DIR = process.env.CACHE_DIR ?? ".";

interface SpotHintaEntry {
  Rank: number;
  DateTime: string;
  PriceNoTax: number;
  PriceWithTax: number; // €/kWh incl. VAT
}

export async function fetchSpotPrices(
  dates: string[],
): Promise<{ map: Map<number, number>; fresh: boolean }> {
  const SLOTS_PER_DAY = 96; // 24 hours × 4 quarter-hours
  const missingDates = dates.filter((d) => {
    const cached = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-${d}.json`);
    return cached === null || Object.keys(cached).length < SLOTS_PER_DAY;
  });

  if (missingDates.length > 0) {
    log(`Fetching spot prices from api.spot-hinta.fi...`);
    const res = await fetch("https://api.spot-hinta.fi/TodayAndDayForward");
    if (!res.ok) {
      log(`  spot-hinta.fi HTTP ${res.status} — falling back to Elering`);
      return { map: await fetchSpotPricesElering(dates), fresh: true };
    }
    const data = (await res.json()) as SpotHintaEntry[];
    const map = new Map<number, number>();
    for (const entry of data) {
      map.set(new Date(entry.DateTime).getTime(), entry.PriceWithTax);
    }
    log(`  Got ${map.size} quarter-hour price slots`);
    return { map, fresh: true };
  }

  const map = new Map<number, number>();
  for (const date of dates) {
    const cached = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-${date}.json`)!;
    for (const [k, v] of Object.entries(cached)) {
      map.set(new Date(k).getTime(), v);
    }
  }
  return { map, fresh: false };
}

export function persistSpotCache(map: Map<number, number>): void {
  const byDate = new Map<string, Record<string, number>>();
  for (const [epoch, price] of map) {
    const date = localDateString(new Date(epoch));
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)![localDateTimeString(new Date(epoch))] = price;
  }
  for (const [date, data] of byDate) {
    const count = Object.keys(data).length;
    if (count < 96) {
      continue;
    }
    writeCache(`${CACHE_DIR}/.spot-cache-${date}.json`, data);
  }
}
