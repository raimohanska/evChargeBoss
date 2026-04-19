import { CONFIG } from "./config.ts";
import type { Slot } from "./types.ts";
import { fetchSpotPrices, persistSpotCache } from "./spot.ts";
import { fetchSolarForecast, persistSolarCache } from "./solar.ts";
import { log, assertNotNull, localDateString } from "./utils.ts";
import { IncompleteDataError } from "./errors.ts";

function datesInRange(from: Date, to: Date): string[] {
  const dates: string[] = [];
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  while (d <= end) {
    dates.push(localDateString(d));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function slotsBetween(from: Date, to: Date): Date[] {
  const slots: Date[] = [];
  const t = new Date(from);
  // align to current 15-min boundary (floor) so the ongoing slot is included
  t.setMinutes(Math.floor(t.getMinutes() / 15) * 15, 0, 0);
  while (t < to) {
    slots.push(new Date(t));
    t.setMinutes(t.getMinutes() + 15);
  }
  return slots;
}

function treeShadingFactor(date: Date): number {
  const schedule = CONFIG.solar.treeShadingSchedule;
  const minutesOfDay = date.getHours() * 60 + date.getMinutes();
  const points = schedule.map(({ time, outputFraction }) => {
    const [h, m] = time.split(":").map(Number);
    return { minutes: h * 60 + m, outputFraction };
  });

  if (minutesOfDay <= points[0].minutes) return 1.0;
  if (minutesOfDay >= points[points.length - 1].minutes) return points[points.length - 1].outputFraction;

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (minutesOfDay >= a.minutes && minutesOfDay < b.minutes) {
      const t = (minutesOfDay - a.minutes) / (b.minutes - a.minutes);
      return a.outputFraction + t * (b.outputFraction - a.outputFraction);
    }
  }
  return 1.0;
}


function nextTargetTime(timeStr: string, from: Date): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const today = new Date(from);
  today.setHours(h, m, 0, 0);
  if (today > from) return today;
  const tomorrow = new Date(from);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(h, m, 0, 0);
  return tomorrow;
}

export async function plan(
  from?: Date,
  overrides?: { targetTime?: Date; targetKwh?: number },
): Promise<Slot[]> {
  const now = from ?? new Date();
  const target = overrides?.targetTime ?? nextTargetTime(CONFIG.charging.targetTime, now);
  const slotStarts = slotsBetween(now, target);

  log(`Planning ${slotStarts.length} slots from ${now.toLocaleTimeString()} to ${target.toLocaleString()}`);

  const dates = datesInRange(now, target);
  const [spotMap, solarMap] = await Promise.all([
    fetchSpotPrices(dates),
    fetchSolarForecast(dates),
  ]);

  const missingSpot = slotStarts.filter((s) => !spotMap.has(s.getTime()));
  if (missingSpot.length > 0) {
    throw new IncompleteDataError(
      `Cannot plan safely — missing ${missingSpot.length} spot price slot(s)`,
      missingSpot,
    );
  }
  persistSpotCache(spotMap);

  // Build a sorted list of solar epochs for nearest-preceding lookup
  const solarEpochs = [...solarMap.keys()].sort((a, b) => a - b);

  const missingSolar = slotStarts.filter((s) => !solarMap.has(s.getTime())).length;
  if (missingSolar > 0) log(`  ${missingSolar} solar slots without exact match — using nearest preceding value`);
  persistSolarCache(solarMap);

  const slots: Slot[] = slotStarts.map((start) => {
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const epoch = start.getTime();

    const spotPriceEurPerKwh = assertNotNull(spotMap.get(epoch), `spot price @ ${start.toISOString()}`);
    const rawSolarW = solarMap.get(epoch)
      ?? solarMap.get([...solarEpochs].reverse().find((k) => k <= epoch) ?? -1)
      ?? 0;
    const solarForecastW = rawSolarW * treeShadingFactor(start);
    const transportCostEurPerKwh = CONFIG.electricity.transportCostEurKwh;

    // Fraction of charger power not covered by solar (clamped to [0, 1])
    const gridFraction = Math.max(0, CONFIG.charging.powerKw - solarForecastW / 1000) / CONFIG.charging.powerKw;

    return {
      start,
      end,
      spotPriceEurPerKwh,
      transportCostEurPerKwh,
      solarForecastW,
      effectiveCostEur: gridFraction * (spotPriceEurPerKwh + transportCostEurPerKwh) * CONFIG.charging.powerKw * 0.25,
      charge: false,
    };
  });

  // Select cheapest N slots
  const targetKwh = overrides?.targetKwh ?? CONFIG.charging.targetKwh;
  const { powerKw } = CONFIG.charging;
  const slotsNeeded = Math.ceil(targetKwh / (powerKw * 0.25)); // 0.25h per slot
  log(`Need ${slotsNeeded} slots to deliver ${targetKwh} kWh at ${powerKw} kW`);

  const sorted = [...slots].sort((a, b) =>
    a.effectiveCostEur - b.effectiveCostEur || a.start.getTime() - b.start.getTime()
  );
  const selected = new Set(sorted.slice(0, slotsNeeded).map((s) => s.start.getTime()));
  slots.forEach((s) => (s.charge = selected.has(s.start.getTime())));

  return slots;
}
