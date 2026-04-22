import type { Slot } from "./types.ts";
import { log, IS_TTY, localTimeShort } from "./utils.ts";

export function printPlan(slots: Slot[]): void {
  const chargeSlots = slots.filter((s) => s.charge);
  const totalCost = chargeSlots.reduce((sum, s) => sum + s.effectiveCostEur, 0);
  const freeSlots = chargeSlots.filter((s) => s.effectiveCostEur === 0).length;

  const hr = IS_TTY ? "\u2500" : "-";
  const currencySuffix = IS_TTY ? " \u20ac" : " EUR"; // " €" = 2, " EUR" = 4  → col widths 7 vs 9
  const costColWidth = `0.000${currencySuffix}`.length;

  log(
    `  ${"TIME".padEnd(5)}  ${"SPOT".padEnd(11)}  ${"SOLAR".padEnd(6)}  ${"COST".padStart(costColWidth)}`,
  );
  log(`  ${hr.repeat(5)}  ${hr.repeat(11)}  ${hr.repeat(6)}  ${hr.repeat(costColWidth)}`);

  for (const s of slots) {
    const time = localTimeShort(s.start).padStart(5, "0");
    const spot = `${(s.spotPriceEurPerKwh * 100).toFixed(2).padStart(5)} c/kWh`;

    const sunW = s.solarForecastW.toFixed(0).padStart(4) + "W";
    const sun =
      s.solarForecastW > 0
        ? IS_TTY
          ? `\x1b[33m\u2600\x1b[0m${sunW}`
          : `*${sunW}`
        : `${"0".padStart(5)}W`;

    const costValue = `${s.effectiveCostEur.toFixed(3)}${currencySuffix}`;
    const freeLabel = "FREE".padStart(costColWidth);
    const cost =
      s.effectiveCostEur === 0 ? (IS_TTY ? `\x1b[92m${freeLabel}\x1b[0m` : freeLabel) : costValue;

    const marker = s.charge ? (IS_TTY ? "\u26a1CHARGE" : "CHARGE ") : "       ";
    log(`  ${time}  ${spot}  ${sun}  ${cost}  ${marker}`);
  }

  log(
    `${hr.repeat(3)} Total: ${chargeSlots.length} slots, ~${totalCost.toFixed(3)} EUR charging cost, ${freeSlots} solar-free slots`,
  );
}
