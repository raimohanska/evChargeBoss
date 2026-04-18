import { readCache, writeCache } from "./cache.ts";
import { log } from "./utils.ts";

interface SpotHintaEntry {
  Rank: number;
  DateTime: string;
  PriceNoTax: number;
  PriceWithTax: number; // €/kWh incl. VAT
}

export async function fetchSpotPrices(dates: string[]): Promise<Map<number, number>> {
  const missingDates = dates.filter((d) => readCache(`.spot-cache-${d}.json`) === null);

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
    const cached = readCache<Record<string, number>>(`.spot-cache-${date}.json`)!;
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
    const date = new Date(epoch).toLocaleDateString("sv-SE");
    if (!byDate.has(date)) byDate.set(date, {});
    byDate.get(date)![new Date(epoch).toLocaleString("sv-SE").replace(" ", "T")] = price;
  }
  for (const [date, data] of byDate) {
    writeCache(`.spot-cache-${date}.json`, data);
  }
  log(`  Spot prices cached (${byDate.size} day file(s)).`);
}
