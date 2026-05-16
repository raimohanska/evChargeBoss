import { readFileSync, writeFileSync, mkdirSync } from "fs";
import path from "path";
import { z } from "zod";
import { localDateTimeString } from "../utils/date-time-format.ts";
import { makeLogger } from "../utils/log.ts";

const log = makeLogger("ev-charging");

const CYCLE_MS = 24 * 60 * 60 * 1000;

export interface HeatingStatistics {
  heatingOnPercentage: number;
  cycleStart: string;
  cycleEnd: string;
}

const HeatingStatisticsSchema = z.object({
  heatingOnPercentage: z.number(),
  cycleStart: z.string(),
  cycleEnd: z.string(),
});

function getStatsFilePath(): string {
  return path.join(process.env.PLANS_DIR ?? ".", ".stats", "heating-statistics.json");
}

export function loadHeatingStatistics(): HeatingStatistics | null {
  const filePath = getStatsFilePath();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
  const result = HeatingStatisticsSchema.safeParse(raw);
  if (!result.success) {
    log(`Warning: heating statistics file failed validation - ignoring.`);
    return null;
  }
  return result.data;
}

export function saveHeatingStatistics(stats: HeatingStatistics): void {
  const filePath = getStatsFilePath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(stats, null, 2));
}

interface HoldEvent {
  time: Date;
  held: boolean;
}

export class HeatingTracker {
  private events: HoldEvent[] = [];
  private latestStats: HeatingStatistics | null;

  constructor(persistedStats: HeatingStatistics | null) {
    this.latestStats = persistedStats;
  }

  onHoldChange(held: boolean, now: Date): void {
    this.events.push({ time: now, held });
    this.checkCycle(now);
  }

  tick(now: Date): void {
    this.checkCycle(now);
  }

  getLatest(): HeatingStatistics | null {
    return this.latestStats;
  }

  private checkCycle(now: Date): void {
    if (this.events.length === 0) return;

    // Loop in case multiple 24h cycles have elapsed since last check
    while (true) {
      const cycleStart = this.events[0].time;
      const cycleEnd = new Date(cycleStart.getTime() + CYCLE_MS);
      if (now < cycleEnd) break;

      // Compute how long heating was ON during [cycleStart, cycleEnd]
      let heatingOnMs = 0;
      let prevTime = cycleStart;
      let prevHeld = this.events[0].held;

      for (let i = 1; i < this.events.length; i++) {
        const ev = this.events[i];
        if (ev.time >= cycleEnd) break;
        // The state prevHeld was active from prevTime until ev.time (capped at cycleEnd)
        const segEnd = ev.time < cycleEnd ? ev.time : cycleEnd;
        if (prevHeld) heatingOnMs += segEnd.getTime() - prevTime.getTime();
        prevTime = ev.time;
        prevHeld = ev.held;
      }
      // Extend last known state to cycleEnd
      if (prevHeld) heatingOnMs += cycleEnd.getTime() - prevTime.getTime();

      const heatingOnPercentage = Math.round((heatingOnMs / CYCLE_MS) * 1000) / 10; // 1 decimal

      const stats: HeatingStatistics = {
        heatingOnPercentage,
        cycleStart: localDateTimeString(cycleStart),
        cycleEnd: localDateTimeString(cycleEnd),
      };

      saveHeatingStatistics(stats);
      log(
        `Heating 24h cycle complete (${stats.cycleStart} -> ${stats.cycleEnd}): ${heatingOnPercentage.toFixed(1)}% heating on`,
      );
      this.latestStats = stats;

      // Find the last held state before cycleEnd (for continuity seed)
      let lastHeldBeforeCycleEnd = this.events[0].held;
      for (const ev of this.events) {
        if (ev.time >= cycleEnd) break;
        lastHeldBeforeCycleEnd = ev.held;
      }

      // Trim events: keep those >= cycleEnd; prepend a continuity seed at cycleEnd
      const remaining = this.events.filter((ev) => ev.time >= cycleEnd);
      this.events = [{ time: cycleEnd, held: lastHeldBeforeCycleEnd }, ...remaining];
    }
  }
}
