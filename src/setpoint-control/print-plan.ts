import type { SetpointSlot } from "./types.ts";
import type { SetpointControlConfig } from "./config.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";
import { IS_TTY } from "../ev-charging/print-plan.ts";

export function printSetpointPlan(slots: SetpointSlot[], spConfig: SetpointControlConfig): void {
  const { setpointCheap, setpointExpensive } = spConfig;
  const hr = IS_TTY ? "\u2500" : "-";

  log(`  ${"TIME".padEnd(5)}  ${"SPOT".padEnd(11)}  ${"SOLAR".padEnd(6)}  SETPOINT`);
  log(`  ${hr.repeat(5)}  ${hr.repeat(11)}  ${hr.repeat(6)}  ${hr.repeat(8)}`);

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

    const spStr = String(s.setpoint).padStart(8);
    let sp = spStr;
    if (IS_TTY) {
      if (s.setpoint === setpointCheap) sp = `\x1b[92m${spStr}\x1b[0m`;
      else if (setpointExpensive != null && s.setpoint === setpointExpensive)
        sp = `\x1b[33m${spStr}\x1b[0m`;
    }

    log(`  ${time}  ${spot}  ${sun}  ${sp}`);
  }

  const cheapSlots = slots.filter((s) => s.setpoint === setpointCheap).length;
  let summary = `${hr.repeat(3)} ${spConfig.name}: ${slots.length} slots, ${cheapSlots} at ${setpointCheap} (cheap/solar)`;
  if (setpointExpensive != null) {
    const expensiveSlots = slots.filter((s) => s.setpoint === setpointExpensive).length;
    if (expensiveSlots > 0) summary += `, ${expensiveSlots} at ${setpointExpensive} (expensive)`;
  }
  log(summary);
}
