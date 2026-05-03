import type { Config } from "../config.ts";
import type { Clock } from "../utils/timing-utils.ts";
import { makeClock } from "../utils/timing-utils.ts";
import { fetchSlots } from "./index.ts";
import { log } from "../utils/log.ts";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WINDOW_DAYS = 2; // today + tomorrow

/**
 * Fetches electricity spot prices and solar forecast for today + tomorrow and
 * writes fresh data to InfluxDB (via fetchSlots).  Exported for testing.
 */
export async function runElectricityPollOnce(config: Config, clock: Clock): Promise<void> {
  const now = clock.now();

  // from = midnight of current day (local time)
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  // to = midnight two days later (covers today + tomorrow in full)
  const to = new Date(from);
  to.setDate(to.getDate() + WINDOW_DAYS);

  const slots = await fetchSlots(from, to, config.electricity, config.solar, false, config.influx);
  log(`[ElectricityPoller] Fetched ${slots.length} slots`);
}

/**
 * Periodically fetches electricity and solar data and writes fresh results to
 * InfluxDB.  Runs every hour; never exits.  Only meaningful when
 * `config.influx` and at least one of `config.electricity.influx` /
 * `config.solar.influx` are configured.
 */
export async function runElectricityPoller(config: Config): Promise<void> {
  const clock = makeClock(config.test?.timeSpeedupFactor ?? 1);
  log("=== Electricity Poller ===");

  while (true) {
    try {
      await runElectricityPollOnce(config, clock);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[ElectricityPoller] ERROR: ${msg}`);
      log("[ElectricityPoller] Retrying in 60s...");
      await clock.sleep(60_000);
      continue;
    }
    await clock.sleep(POLL_INTERVAL_MS);
  }
}
