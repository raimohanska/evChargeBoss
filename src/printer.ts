import type { Slot } from "./types.ts";
import { log, IS_TTY } from "./utils.ts";

export function printPlan(slots: Slot[]): void {
  const chargeSlots = slots.filter((s) => s.charge);
  const totalCost = chargeSlots.reduce((sum, s) => sum + s.effectiveCostEur, 0);
  const freeSlots = chargeSlots.filter((s) => s.effectiveCostEur === 0).length;

  const hr = IS_TTY ? "─" : "-";
  log(`  ${"TIME".padEnd(5)}  ${"SPOT".padEnd(11)}  ${"SOLAR".padEnd(6)}  ${"COST".padStart(7)}`);
  log(`  ${hr.repeat(5)}  ${hr.repeat(11)}  ${hr.repeat(6)}  ${hr.repeat(7)}`);
  for (const s of slots) {
    const time = s.start.toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" });
    const spot = `${(s.spotPriceEurPerKwh * 100).toFixed(2).padStart(5)} c/kWh`;

    const sunW = s.solarForecastW.toFixed(0).padStart(4) + "W";
    const sun = s.solarForecastW > 0
      ? (IS_TTY ? `\x1b[33m*\x1b[0m${sunW}` : `*${sunW}`)
      : `${"0".padStart(5)}W`;

    const costEur = `${s.effectiveCostEur.toFixed(3)} EUR`;
    const cost = s.effectiveCostEur === 0
      ? (IS_TTY ? `\x1b[92m   FREE\x1b[0m` : `   FREE`)
      : (IS_TTY ? `${s.effectiveCostEur.toFixed(3)} \u20ac` : costEur);

    const marker = s.charge ? (IS_TTY ? "\u26a1CHARGE" : "CHARGE ") : "       ";
    log(`  ${time}  ${spot}  ${sun}  ${cost}  ${marker}`);
  }
  log(`${hr.repeat(3)} Total: ${chargeSlots.length} slots, ~${totalCost.toFixed(3)} EUR charging cost, ${freeSlots} solar-free slots`);
}
