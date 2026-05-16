import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { z } from "zod";
import { localDateTimeString } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";

const statsLog = makeLogger("ev-charging-heating-stats");

const STATS_INTERVAL_MS = 15 * 60 * 1000;

export interface HeatingPowerStatistics {
  /** The (100 - maxHoldPercentage)th power percentile: only maxHoldPercentage% of samples exceed this */
  holdPowerLevel: number;
  /** holdPowerLevel + holdMargin (watts) */
  powerHoldThreshold: number;
  /** Fraction (0–1) of samples strictly below powerHoldThreshold */
  powerHoldFactor: number;
  /** Percentage of samples at or above thresholdW (1 decimal) */
  heatingOnPercentage: number;
  sampleCount: number;
  periodStart: string;
  periodEnd: string;
}

// Keep the old name as an alias so callers using the old type still compile.
export type HeatingStatistics = HeatingPowerStatistics;

const HeatingPowerStatisticsSchema = z.object({
  holdPowerLevel: z.number(),
  powerHoldThreshold: z.number(),
  powerHoldFactor: z.number(),
  heatingOnPercentage: z.number(),
  sampleCount: z.number(),
  periodStart: z.string(),
  periodEnd: z.string(),
});

function getStatsFilePath(): string {
  return path.join(process.env.PLANS_DIR ?? ".", ".stats", "heating-statistics.json");
}

export function loadHeatingStatistics(): HeatingPowerStatistics | null {
  const filePath = getStatsFilePath();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  const result = HeatingPowerStatisticsSchema.safeParse(raw);
  if (!result.success) {
    statsLog(`Warning: heating statistics file failed validation - ignoring.`);
    return null;
  }
  return result.data;
}

export function saveHeatingStatistics(stats: HeatingPowerStatistics): void {
  const filePath = getStatsFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(stats, null, 2));
}

export interface HeatingTrackerConfig {
  thresholdW: number;
  maxHoldPercentage: number;
  holdMargin: number;
  statisticsPeriodHours: number;
}

export class HeatingTracker {
  private readonly cfg: HeatingTrackerConfig;
  private readonly capacity: number;

  private latestHeatingW = 0;
  private hasReceivedWatts = false;
  private samples: number[] = [];
  private lastStatsTime: Date | null = null;
  private latestStats: HeatingPowerStatistics | null;

  constructor(cfg: HeatingTrackerConfig, persistedStats: HeatingPowerStatistics | null) {
    this.cfg = cfg;
    this.capacity = cfg.statisticsPeriodHours * 60;
    this.latestStats = persistedStats;
  }

  /** Called every time a new heating power reading arrives from MQTT. */
  onHeatingWatts(watts: number): void {
    this.latestHeatingW = watts;
    this.hasReceivedWatts = true;
  }

  /**
   * Called every minute by setInterval to record the current heating power.
   * Only records once at least one MQTT reading has been received.
   */
  takeSample(_now: Date): void {
    if (!this.hasReceivedWatts) return;
    this.samples.push(this.latestHeatingW);
    if (this.samples.length > this.capacity) {
      this.samples.shift();
    }
  }

  /** Called by the coordinator at slot boundaries to trigger stats logging if due. */
  tick(now: Date): void {
    this.checkStats(now);
  }

  getLatest(): HeatingPowerStatistics | null {
    return this.latestStats;
  }

  private checkStats(now: Date): void {
    if (this.samples.length < this.capacity) return;
    if (
      this.lastStatsTime !== null &&
      now.getTime() - this.lastStatsTime.getTime() < STATS_INTERVAL_MS
    )
      return;

    const n = this.samples.length;
    const sorted = [...this.samples].sort((a, b) => a - b);

    // (100 - maxHoldPercentage)th percentile: only maxHoldPercentage% of samples exceed this
    const percentileIndex = Math.min(Math.floor((1 - this.cfg.maxHoldPercentage / 100) * n), n - 1);
    const holdPowerLevel = sorted[percentileIndex];
    const powerHoldThreshold = holdPowerLevel + this.cfg.holdMargin;
    const powerHoldFactor = this.samples.filter((s) => s < powerHoldThreshold).length / n;
    const heatingOnCount = this.samples.filter((s) => s >= this.cfg.thresholdW).length;
    const heatingOnPercentage = Math.round((heatingOnCount / n) * 1000) / 10;

    const periodEnd = localDateTimeString(now);
    const periodStart = localDateTimeString(new Date(now.getTime() - (n - 1) * 60_000));

    const stats: HeatingPowerStatistics = {
      holdPowerLevel,
      powerHoldThreshold,
      powerHoldFactor,
      heatingOnPercentage,
      sampleCount: n,
      periodStart,
      periodEnd,
    };

    saveHeatingStatistics(stats);
    statsLog(
      `holdPowerLevel=${holdPowerLevel}W threshold=${powerHoldThreshold}W` +
        ` holdFactor=${powerHoldFactor.toFixed(3)} heatingOn=${heatingOnPercentage.toFixed(1)}%` +
        ` samples=${n} period=${periodStart} -> ${periodEnd}`,
    );
    this.latestStats = stats;
    this.lastStatsTime = now;
  }
}
