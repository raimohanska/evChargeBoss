import { z } from "zod";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("electricity");

// Finnish VAT rate (25.5 % since September 2024)
const FI_VAT = 0.255;

const EleringEntry = z.object({
  timestamp: z.number().int().positive(),
  price: z.number(),
});

const EleringResponse = z.object({
  success: z.literal(true),
  data: z.object({
    fi: z.array(EleringEntry).min(1),
  }),
});

/**
 * Fetch spot prices from Elering NPS API for the given local-date strings.
 * Returns a map of epoch-ms → price in €/kWh incl. Finnish VAT.
 * Used as a fallback when spot-hinta.fi is unavailable.
 */
export async function fetchSpotPricesElering(dates: string[]): Promise<Map<number, number>> {
  const sorted = [...dates].sort();
  // Date-time strings without a timezone suffix are parsed as local time in JS,
  // so these boundaries are correct for whichever timezone the process runs in.
  const start = new Date(sorted[0] + "T00:00:00").toISOString();
  const end = new Date(sorted[sorted.length - 1] + "T23:59:59").toISOString();
  const url = `https://dashboard.elering.ee/api/nps/price?fields=fi&start=${start}&end=${end}`;
  log(`Fetching spot prices from Elering (fallback): ${url}`);

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Elering HTTP ${res.status}`);

  const parsed = EleringResponse.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(`Elering response validation failed: ${parsed.error.message}`);
  }

  const map = new Map<number, number>();
  for (const entry of parsed.data.data.fi) {
    // timestamp is Unix seconds (UTC); price is EUR/MWh excl. VAT
    const epochMs = entry.timestamp * 1000;
    const priceEurKwh = (entry.price / 1000) * (1 + FI_VAT);
    map.set(epochMs, priceEurKwh);
  }

  log(`  Got ${map.size} quarter-hour price slots from Elering`);
  return map;
}
