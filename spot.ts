import { readCache, writeCache } from "./cache.ts";
import { log } from "./utils.ts";

interface SpotHintaEntry {
  Rank: number;
  DateTime: string;
  PriceNoTax: number;
  PriceWithTax: number; // €/kWh incl. VAT
}

export async function fetchSpotPrices(): Promise<Map<number, number>> {
  const cached = readCache<Record<string, number>>(".spot-cache.json");
  if (cached) {
    const map = new Map(Object.entries(cached).map(([k, v]) => [Number(k), v]));
    log(`  Spot prices loaded from cache (${map.size} slots)`);
    return map;
  }

  log("Fetching spot prices from api.spot-hinta.fi...");
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

export function persistSpotCache(map: Map<number, number>): void {
  writeCache(".spot-cache.json", Object.fromEntries(map));
  log("  Spot prices cached.");
}
