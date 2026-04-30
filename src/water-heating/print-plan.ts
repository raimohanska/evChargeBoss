import type { WaterHeatingSlot } from "./types.ts";
import type { WaterHeatingConfig } from "./config.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";
import { IS_TTY } from "../ev-charging/print-plan.ts";

export function printWaterHeatingPlan(
  slots: WaterHeatingSlot[],
  whConfig: WaterHeatingConfig,
): void {
  const { targetTemperatureCheap: cheapTemp, targetTemperatureExpensive: expensiveTemp } = whConfig;
  const hr = IS_TTY ? "\u2500" : "-";

  log(`  ${"TIME".padEnd(5)}  ${"SPOT".padEnd(11)}  ${"SOLAR".padEnd(6)}  TEMP`);
  log(`  ${hr.repeat(5)}  ${hr.repeat(11)}  ${hr.repeat(6)}  ${hr.repeat(4)}`);

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

    const tempStr = `${s.targetTemp}°C`.padStart(4);
    let temp = tempStr;
    if (IS_TTY) {
      if (s.targetTemp === cheapTemp) temp = `\x1b[92m${tempStr}\x1b[0m`;
      else if (expensiveTemp != null && s.targetTemp === expensiveTemp)
        temp = `\x1b[33m${tempStr}\x1b[0m`;
    }

    log(`  ${time}  ${spot}  ${sun}  ${temp}`);
  }

  const cheapSlots = slots.filter((s) => s.targetTemp === cheapTemp).length;
  let summary = `${hr.repeat(3)} Water heating: ${slots.length} slots, ${cheapSlots} at ${cheapTemp}°C (cheap/solar)`;
  if (expensiveTemp != null) {
    const expensiveSlots = slots.filter((s) => s.targetTemp === expensiveTemp).length;
    if (expensiveSlots > 0) summary += `, ${expensiveSlots} at ${expensiveTemp}°C (expensive)`;
  }
  log(summary);
}
