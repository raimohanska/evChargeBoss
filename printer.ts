import type { Slot } from "./types.ts";
import { log } from "./utils.ts";

export function printPlan(slots: Slot[]): void {
  const chargeSlots = slots.filter((s) => s.charge);
  const totalCost = chargeSlots.reduce((sum, s) => sum + s.effectiveCostEur, 0);
  const freeSlots = chargeSlots.filter((s) => s.effectiveCostEur === 0).length;

  log(`  ${"TIME".padEnd(5)}  ${"SPOT".padEnd(11)}  ${"SOLAR".padEnd(6)}  ${"COST".padStart(7)}`);
  log(`  ${"─".repeat(5)}  ${"─".repeat(11)}  ${"─".repeat(6)}  ${"─".repeat(7)}`);
  for (const s of slots) {
    const time = s.start.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
    const spot = `${(s.spotPriceEurPerKwh * 100).toFixed(2).padStart(5)} c/kWh`;
    const sun = s.solarForecastW > 0 ? `\x1b[33m☀\x1b[0m${s.solarForecastW.toFixed(0).padStart(4)}W` : `${"0".padStart(5)}W`;
    const cost = s.effectiveCostEur === 0 ? `\x1b[92m   FREE\x1b[0m` : `${s.effectiveCostEur.toFixed(3)} €`;
    const marker = s.charge ? "⚡CHARGE" : "       ";
    log(`  ${time}  ${spot}  ${sun}  ${cost}  ${marker}`);
  }
  log(`─── Total: ${chargeSlots.length} slots, ~${(totalCost).toFixed(3)} € charging cost, ${freeSlots} solar-free slots`);
}
