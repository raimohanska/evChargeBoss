import type { Slot } from "./types.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("ev-charging");

export interface PrintPlanOptions {
  powerKw: number;
  targetTime: Date;
  targetKwh: number;
  chargedKwh: number;
}

export function sessionSummaryLine(opts: PrintPlanOptions): string {
  const { powerKw, targetTime, targetKwh, chargedKwh } = opts;
  const remainingKwh = Math.max(0, targetKwh - chargedKwh);
  return (
    `Power: ${powerKw} kW  Target: ${localTimeShort(targetTime)}` +
    `  Charged: ${chargedKwh.toFixed(1)} / ${targetKwh.toFixed(1)} kWh` +
    `  Remaining: ${remainingKwh.toFixed(1)} kWh`
  );
}

export function printPlan(slots: Slot[], opts: PrintPlanOptions): void {
  log(sessionSummaryLine(opts));

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
export const IS_TTY = process.stdout.isTTY === true;
