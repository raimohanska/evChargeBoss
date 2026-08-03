import { readCache, writeCache } from "./cache.ts";
import { assertNetworkFetchAllowed } from "./no-fetch.ts";
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

interface PorssisahkoEntry {
  price: number; // cents/kWh incl. VAT
  startDate: string; // ISO 8601 UTC
  endDate: string;
}

/**
 * Fetch quarter-hour spot prices from api.spot-hinta.fi.  Today and
 * DayForward are fetched separately: they are rate-limited per endpoint,
 * while the combined TodayAndDayForward endpoint is the one that 429s.
 * Prices are returned in €/kWh incl. VAT.
 */
async function fetchSpotHintaPrices(): Promise<Map<number, number>> {
  const responses = await Promise.all(
    ["https://api.spot-hinta.fi/Today", "https://api.spot-hinta.fi/DayForward"].map(async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`spot-hinta.fi HTTP ${res.status}`);
      return (await res.json()) as SpotHintaEntry[];
    }),
  );
  const map = new Map<number, number>();
  for (const data of responses) {
    for (const entry of data) {
      map.set(new Date(entry.DateTime).getTime(), entry.PriceWithTax);
    }
  }
  return map;
}

/**
 * Fallback source: porssisahko.net v2 latest-prices, a rolling ~48 h window
 * that fully covers today and tomorrow in Finnish local time.  Quarter-hour
 * prices are in cents/kWh incl. VAT, so they are divided by 100 to match the
 * €/kWh used everywhere else in this module.
 */
async function fetchPorssisahkoPrices(): Promise<Map<number, number>> {
  const res = await fetch("https://api.porssisahko.net/v2/latest-prices.json");
  if (!res.ok) throw new Error(`porssisahko.net HTTP ${res.status}`);
  const json = (await res.json()) as { prices: PorssisahkoEntry[] };
  const map = new Map<number, number>();
  for (const entry of json.prices) {
    map.set(new Date(entry.startDate).getTime(), entry.price / 100);
  }
  return map;
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
    assertNetworkFetchAllowed(`spot prices for ${missingDates.join(", ")}`);
    log(`Fetching spot prices from api.spot-hinta.fi... (missing: ${missingDates.join(", ")})`);
    let map: Map<number, number>;
    try {
      map = await fetchSpotHintaPrices();
    } catch (err) {
      // spot-hinta.fi rate-limits hard (HTTP 429 on the shared IP/endpoint),
      // so fall back to porssisahko.net on any failure to keep planning alive.
      const reason = err instanceof Error ? err.message : String(err);
      log(`  api.spot-hinta.fi unavailable (${reason}) - falling back to porssisahko.net`);
      map = await fetchPorssisahkoPrices();
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
          `  Spot cache for ${date}: only ${count}/96 slots - skipping write to avoid partial cache`,
        );
      continue;
    }
    writeCache(`${CACHE_DIR}/.spot-cache-${date}.json`, data);
    written++;
  }
  if (verbose) log(`  Spot prices cached (${written} day file(s)).`);
}
