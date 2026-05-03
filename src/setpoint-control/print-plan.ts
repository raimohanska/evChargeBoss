import type { SetpointSlot } from "./types.ts";
import type { SetpointControlConfig } from "./config.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";
import { IS_TTY } from "../ev-charging/print-plan.ts";

const COST_WIDTH = 9; // width of "expensive"

function costLabel(tier: SetpointSlot["costTier"]): string {
  const label = tier.padEnd(COST_WIDTH);
  if (!IS_TTY) return label;
  if (tier === "cheap") return `\x1b[32m${label}\x1b[0m`;
  if (tier === "expensive") return `\x1b[31m${label}\x1b[0m`;
  return label; // average: no colour
}

export function printSetpointPlan(slots: SetpointSlot[], spConfig: SetpointControlConfig): void {
  const hr = IS_TTY ? "\u2500" : "-";

  log(`  TIME   SOLAR       SPOT          COST       SETPOINT`);
  log(
    `  ${hr.repeat(5)}  ${hr.repeat(10)}  ${hr.repeat(10)}  ${hr.repeat(COST_WIDTH)}  ${hr.repeat(8)}`,
  );

  for (const s of slots) {
    const time = localTimeShort(s.start).padStart(5, "0");
    const solar = `${s.solarForecastW.toFixed(0).padStart(6)}W`;
    const spot = `${(s.spotPriceEurPerKwh * 100).toFixed(2).padStart(5)} c/kWh`;
    const cost = costLabel(s.costTier);
    const setpoint = String(s.setpoint).padStart(8);
    log(`  ${time}  ${solar}  ${spot}  ${cost}  ${setpoint}`);
  }

  const cheapCount = slots.filter((s) => s.costTier === "cheap").length;
  const expensiveCount = slots.filter((s) => s.costTier === "expensive").length;
  let summary = `${hr.repeat(3)} ${spConfig.name}: ${slots.length} slots`;
  if (cheapCount > 0) summary += `, ${cheapCount} cheap`;
  if (expensiveCount > 0) summary += `, ${expensiveCount} expensive`;
  log(summary);
}
