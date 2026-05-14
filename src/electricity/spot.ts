import { readCache, writeCache } from "./cache.ts";
import { localDateString, localDateTimeString } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";

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
  verbose?: boolean,
): Promise<{ map: Map<number, number>; fresh: boolean }> {
  const SLOTS_PER_DAY = 96; // 24 hours × 4 quarter-hours
  const missingDates = dates.filter((d) => {
    const cached = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-${d}.json`);
    return cached === null || Object.keys(cached).length < SLOTS_PER_DAY;
  });

  if (missingDates.length > 0) {
    log(`Fetching spot prices from api.spot-hinta.fi... (missing: ${missingDates.join(", ")})`);
    const res = await fetch("https://api.spot-hinta.fi/TodayAndDayForward");
    if (!res.ok) throw new Error(`spot-hinta.fi HTTP ${res.status}`);
    const data = (await res.json()) as SpotHintaEntry[];
    const map = new Map<number, number>();
    for (const entry of data) {
      map.set(new Date(entry.DateTime).getTime(), entry.PriceWithTax);
    }
    if (verbose) log(`  Got ${map.size} quarter-hour price slots`);
    return { map, fresh: true };
  }

  const map = new Map<number, number>();
  for (const date of dates) {
    const cached = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-${date}.json`)!;
    for (const [k, v] of Object.entries(cached)) {
      map.set(new Date(k).getTime(), v);
    }
  }
  if (verbose) log(`  Spot prices loaded from cache (${map.size} slots)`);
  return { map, fresh: false };
}

export function persistSpotCache(map: Map<number, number>, verbose?: boolean): void {
  const byDate = new Map<string, Record<string, number>>();
  for (const [epoch, price] of map) {
    const date = localDateString(new Date(epoch));
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)![localDateTimeString(new Date(epoch))] = price;
  }
  let written = 0;
  for (const [date, data] of byDate) {
    const count = Object.keys(data).length;
    if (count < 96) {
      if (verbose)
        log(
          `  Spot cache for ${date}: only ${count}/96 slots — skipping write to avoid partial cache`,
        );
      continue;
    }
    writeCache(`${CACHE_DIR}/.spot-cache-${date}.json`, data);
    written++;
  }
  if (verbose) log(`  Spot prices cached (${written} day file(s)).`);
}
