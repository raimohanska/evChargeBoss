import { existsSync } from "fs";
import type { Config } from "../config.ts";
import type { Clock } from "../utils/timing-utils.ts";
import { makeClock } from "../utils/timing-utils.ts";
import { fetchSlots } from "./index.ts";
import { datesInRange } from "./dates.ts";
import { IncompleteDataError } from "./IncompleteDataError.ts";
import { localTimeShort } from "../utils/date-time-format.ts";
import { log } from "../utils/log.ts";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const WINDOW_DAYS = 2; // today + tomorrow

// Must match the constant in spot.ts and solar.ts — all three read the same env var.
const CACHE_DIR = process.env.CACHE_DIR ?? ".";

function allCached(dates: string[]): boolean {
  return dates.every(
    (d) =>
      existsSync(`${CACHE_DIR}/.spot-cache-${d}.json`) &&
      existsSync(`${CACHE_DIR}/.solar-cache-${d}.json`),
  );
}

/**
 * Fetches electricity spot prices and solar forecast for today + tomorrow and
 * writes fresh data to InfluxDB (via fetchSlots).  Exported for testing.
 */
export async function runElectricityPollOnce(config: Config, clock: Clock): Promise<void> {
  const now = clock.now();

  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  // to = 1 ms before midnight of the day after the window ends.
  // Using midnight + WINDOW_DAYS would make datesInRange() include one extra date
  // that the APIs never populate, causing a spurious cache miss on every poll.
  const to = new Date(from.getTime() + WINDOW_DAYS * 24 * 60 * 60 * 1000 - 1);

  const dates = datesInRange(from, to);
  if (allCached(dates)) {
    log("[ElectricityPoller] Cache hit — skipping fetch");
    return;
  }

  try {
    const slots = await fetchSlots(
      from,
      to,
      config.electricity,
      config.solar,
      false,
      config.influx,
    );
    log(`[ElectricityPoller] Fetched ${slots.length} slots`);
  } catch (err) {
    if (err instanceof IncompleteDataError && err.missingSlots.length > 0) {
      const firstMissing = err.missingSlots[0];
      if (firstMissing.getTime() > from.getTime()) {
        // Partial data available — fetch and write what we have.
        const slots = await fetchSlots(
          from,
          firstMissing,
          config.electricity,
          config.solar,
          false,
          config.influx,
        );
        log(
          `[ElectricityPoller] Fetched ${slots.length} slots (partial — spot prices until ${localTimeShort(firstMissing)})`,
        );
        return;
      }
    }
    throw err;
  }
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
      log(`[ElectricityPoller] Fetch failed: ${msg} — retrying in 60s`);
      await clock.sleep(60_000);
      continue;
    }
    await clock.sleep(POLL_INTERVAL_MS);
  }
}
