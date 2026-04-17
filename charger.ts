import type { Slot } from "./config.ts";
import { log, sleep } from "./utils.ts";

export async function runCharging(slots: Slot[]) {
  const now = new Date();
  const upcoming = slots.filter((s) => s.end > now);

  for (const slot of upcoming) {
    const msUntilStart = slot.start.getTime() - Date.now();
    if (msUntilStart > 0) {
      log(`Waiting ${Math.round(msUntilStart / 1000)}s until slot ${slot.start.toLocaleTimeString()}`);
      await sleep(msUntilStart);
    }

    const action = slot.charge ? "ON " : "OFF";
    log(`[CHARGER ${action}] slot ${slot.start.toLocaleTimeString()}–${slot.end.toLocaleTimeString()} | ${
      slot.charge
        ? slot.effectiveCostEur === 0
          ? "solar-free"
          : `${slot.effectiveCostEur.toFixed(3)} €`
        : "too expensive"
    }`);

    // Wait for slot to end
    const msUntilEnd = slot.end.getTime() - Date.now();
    if (msUntilEnd > 0) await sleep(msUntilEnd);
  }

  log("Charging session complete.");
}
