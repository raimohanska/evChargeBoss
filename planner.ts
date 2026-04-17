import { CONFIG } from "./config.ts";
import type { Slot } from "./config.ts";
import { fetchSpotPrices } from "./spot.ts";
import { fetchSolarForecast } from "./solar.ts";
import { log, assertNotNull } from "./utils.ts";

function slotsBetween(from: Date, to: Date): Date[] {
  const slots: Date[] = [];
  const t = new Date(from);
  // align to next 15-min boundary
  t.setMinutes(Math.ceil(t.getMinutes() / 15) * 15, 0, 0);
  while (t < to) {
    slots.push(new Date(t));
    t.setMinutes(t.getMinutes() + 15);
  }
  return slots;
}

function nextDayAt(timeStr: string): Date {
  const [h, m] = timeStr.split(":").map(Number);
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(h, m, 0, 0);
  return d;
}

export async function plan(): Promise<Slot[]> {
  const now = new Date();
  const target = nextDayAt(CONFIG.charging.targetTime);
  const slotStarts = slotsBetween(now, target);

  log(`Planning ${slotStarts.length} slots from ${now.toLocaleTimeString()} to ${target.toLocaleString()}`);

  const [spotMap, solarMap] = await Promise.all([
    fetchSpotPrices(),
    fetchSolarForecast(),
  ]);

  const missingSpot = slotStarts.filter((s) => !spotMap.has(s.getTime()));
  if (missingSpot.length > 0) {
    throw new Error(
      `INCOMPLETE DATA — cannot plan safely. Missing ${missingSpot.length} spot price slot(s):\n` +
      missingSpot.map((s) => `  ✗ spot@${s.toISOString()}`).join("\n")
    );
  }

  const missingSolar = slotStarts.filter((s) => !solarMap.has(s.getTime())).length;
  if (missingSolar > 0) log(`  ${missingSolar} solar slots missing (assumed 0 W — no sun)`);

  const slots: Slot[] = slotStarts.map((start) => {
    const end = new Date(start.getTime() + 15 * 60 * 1000);
    const epoch = start.getTime();

    const spotPriceEur = assertNotNull(spotMap.get(epoch), `spot price @ ${start.toISOString()}`);
    const solarForecastW = solarMap.get(epoch) ?? 0;
    const isFree = solarForecastW >= CONFIG.solar.freeThresholdW;
    const transportCostEur = CONFIG.electricity.transportCostEurKwh;

    return {
      start,
      end,
      spotPriceEur,
      transportCostEur,
      solarForecastW,
      effectivePriceEur: isFree ? 0 : spotPriceEur + transportCostEur,
      charge: false,
    };
  });

  // Select cheapest N slots
  const { targetKwh, powerKw } = CONFIG.charging;
  const slotsNeeded = Math.ceil(targetKwh / (powerKw * 0.25)); // 0.25h per slot
  log(`Need ${slotsNeeded} slots to deliver ${targetKwh} kWh at ${powerKw} kW`);

  const sorted = [...slots].sort((a, b) => a.effectivePriceEur - b.effectivePriceEur);
  const selected = new Set(sorted.slice(0, slotsNeeded).map((s) => s.start.getTime()));
  slots.forEach((s) => (s.charge = selected.has(s.start.getTime())));

  printPlan(slots);
  return slots;
}

function printPlan(slots: Slot[]) {
  const chargeSlots = slots.filter((s) => s.charge);
  const totalCost = chargeSlots.reduce(
    (sum, s) => sum + s.effectivePriceEur * CONFIG.charging.powerKw * 0.25,
    0
  );
  const freeSlots = chargeSlots.filter((s) => s.effectivePriceEur === 0).length;

  log("─── Charging Plan ──────────────────────────────────────");
  for (const s of slots) {
    const time = s.start.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
    const price = s.effectivePriceEur === 0
      ? "  FREE☀️ "
      : `${(s.effectivePriceEur * 100).toFixed(2).padStart(5)} c/kWh`;
    const solar = s.solarForecastW > 0 ? `☀${s.solarForecastW.toFixed(0).padStart(4)}W` : "   0W  ";
    const marker = s.charge ? "⚡CHARGE" : "       ";
    log(`  ${time}  ${price}  ${solar}  ${marker}`);
  }
  log(`─── Total: ${chargeSlots.length} slots, ~${(totalCost).toFixed(3)} € charging cost, ${freeSlots} solar-free slots`);
}
