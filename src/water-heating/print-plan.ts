import type { WaterHeatingSlot } from "./types.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";
import { IS_TTY } from "../ev-charging/print-plan.ts";

export function printWaterHeatingPlan(slots: WaterHeatingSlot[]): void {
  const maxTemp = Math.max(...slots.map((s) => s.targetTemp));
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
    const temp =
      s.targetTemp === maxTemp ? (IS_TTY ? `\x1b[92m${tempStr}\x1b[0m` : tempStr) : tempStr;

    log(`  ${time}  ${spot}  ${sun}  ${temp}`);
  }

  const hotSlots = slots.filter((s) => s.targetTemp === maxTemp).length;
  log(
    `${hr.repeat(3)} Water heating: ${slots.length} slots, ${hotSlots} at ${maxTemp}°C (cheap/solar)`,
  );
}
