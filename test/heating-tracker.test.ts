import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// MUST set PLANS_DIR before importing the module under test,
// because getStatsFilePath() captures process.env.PLANS_DIR at call time.
const tmpDir = mkdtempSync(path.join(tmpdir(), "heating-tracker-test-"));
process.env.PLANS_DIR = tmpDir;

import {
  HeatingTracker,
  loadHeatingStatistics,
  saveHeatingStatistics,
  type HeatingTrackerConfig,
  type HeatingPowerStatistics,
} from "../src/ev-charging/heating-tracker.ts";

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const MIN_MS = 60_000;

/** Default config: 1 h period (60 samples), maxHoldPercentage=20, holdMargin=100 */
const defaultCfg: HeatingTrackerConfig = {
  maxHoldPercentage: 20,
  holdMargin: 100,
  statisticsPeriodHours: 1,
};

function makeDate(offsetMs: number, base = new Date("2026-01-01T00:00:00")): Date {
  return new Date(base.getTime() + offsetMs);
}

/**
 * Set watts on the tracker, then call takeSample() `count` times at consecutive
 * minute boundaries starting from `startMinute`.
 */
function feedSamples(
  tracker: HeatingTracker,
  startMinute: number,
  count: number,
  watts: number,
): void {
  tracker.onHeatingWatts(watts);
  for (let i = 0; i < count; i++) {
    tracker.takeSample(makeDate((startMinute + i) * MIN_MS));
  }
}

describe("HeatingTracker", () => {
  describe("sample recording", () => {
    it("getLatest returns null before buffer is filled", () => {
      const tracker = new HeatingTracker(defaultCfg, null);
      feedSamples(tracker, 0, 30, 1000); // only 30 of 60 required
      tracker.tick(makeDate(31 * MIN_MS));
      assert.equal(tracker.getLatest(), null);
    });

    it("getLatest returns persisted stats before buffer fills", () => {
      const persisted: HeatingPowerStatistics = {
        holdPowerLevel: 2800,
        powerHoldThreshold: 2900,
        powerHoldFactor: 0.8,
        sampleCount: 60,
        periodStart: "2026-01-01T00:00:00",
        periodEnd: "2026-01-01T01:00:00",
      };
      const tracker = new HeatingTracker(defaultCfg, persisted);
      feedSamples(tracker, 0, 10, 500);
      assert.deepEqual(tracker.getLatest(), persisted);
    });

    it("no samples recorded before first onHeatingWatts call", () => {
      const tracker = new HeatingTracker(defaultCfg, null);
      // takeSample with no prior onHeatingWatts → nothing recorded
      for (let i = 0; i < 60; i++) tracker.takeSample(makeDate(i * MIN_MS));
      tracker.tick(makeDate(60 * MIN_MS));
      assert.equal(tracker.getLatest(), null);
    });
  });

  describe("statistics computation", () => {
    it("holdPowerLevel is the (100-maxHoldPercentage)th percentile", () => {
      // 60 samples with values 1..60 W
      const tracker = new HeatingTracker(defaultCfg, null);
      for (let i = 0; i < 60; i++) {
        tracker.onHeatingWatts(i + 1);
        tracker.takeSample(makeDate(i * MIN_MS));
      }
      tracker.tick(makeDate(60 * MIN_MS));
      const stats = tracker.getLatest();
      assert.notEqual(stats, null);
      // sorted[0..59] = 1..60
      // percentileIndex = floor((1 - 0.20) * 60) = floor(48) = 48
      // sorted[48] = 49
      assert.equal(stats!.holdPowerLevel, 49);
    });

    it("powerHoldThreshold = holdPowerLevel + holdMargin", () => {
      const tracker = new HeatingTracker(defaultCfg, null);
      feedSamples(tracker, 0, 60, 2000);
      tracker.tick(makeDate(60 * MIN_MS));
      const stats = tracker.getLatest();
      assert.notEqual(stats, null);
      assert.equal(stats!.powerHoldThreshold, stats!.holdPowerLevel + defaultCfg.holdMargin);
    });

    it("powerHoldFactor is fraction of samples below powerHoldThreshold", () => {
      // Use holdMargin=0 so powerHoldThreshold === holdPowerLevel, making the
      // fraction exactly (100 - maxHoldPercentage)% = 0.8
      const cfg: HeatingTrackerConfig = { ...defaultCfg, holdMargin: 0 };
      const tracker = new HeatingTracker(cfg, null);
      feedSamples(tracker, 0, 48, 1000); // 48 samples at 1000 W
      feedSamples(tracker, 48, 12, 5000); // 12 samples at 5000 W
      tracker.tick(makeDate(60 * MIN_MS));
      const stats = tracker.getLatest();
      assert.notEqual(stats, null);
      // sorted[48] = 5000 → holdPowerLevel = 5000, threshold = 5000
      // count(s < 5000) = 48 → 48/60 = 0.8
      assert.equal(stats!.powerHoldFactor, 48 / 60);
    });

    it("stats not recomputed until 15 minutes have elapsed", () => {
      const tracker = new HeatingTracker(defaultCfg, null);
      feedSamples(tracker, 0, 60, 1000);
      // First tick: stats compute, lastStatsTime = makeDate(60*MIN_MS)
      tracker.tick(makeDate(60 * MIN_MS));
      const first = tracker.getLatest();
      assert.notEqual(first, null);
      // 14 min later: no recompute
      feedSamples(tracker, 60, 14, 5000);
      tracker.tick(makeDate((60 + 14) * MIN_MS));
      assert.deepEqual(tracker.getLatest(), first);
      // 15 min later: recompute
      feedSamples(tracker, 74, 1, 5000);
      tracker.tick(makeDate((60 + 15) * MIN_MS));
      assert.notDeepEqual(tracker.getLatest(), first);
    });
  });

  describe("persistence", () => {
    it("persists stats to file and loadHeatingStatistics reads them back", () => {
      const stats: HeatingPowerStatistics = {
        holdPowerLevel: 2800,
        powerHoldThreshold: 2900,
        powerHoldFactor: 0.82,
        sampleCount: 60,
        periodStart: "2026-01-01T00:00:00",
        periodEnd: "2026-01-01T01:00:00",
      };
      saveHeatingStatistics(stats);
      const loaded = loadHeatingStatistics();
      assert.deepEqual(loaded, stats);
    });

    it("loadHeatingStatistics returns null when file missing", () => {
      const origDir = process.env.PLANS_DIR;
      const emptyDir = mkdtempSync(path.join(tmpdir(), "heating-empty-"));
      process.env.PLANS_DIR = emptyDir;
      try {
        const loaded = loadHeatingStatistics();
        assert.equal(loaded, null);
      } finally {
        process.env.PLANS_DIR = origDir;
        rmSync(emptyDir, { recursive: true, force: true });
      }
    });

    it("loadHeatingStatistics returns null when file has incompatible schema", () => {
      const origDir = process.env.PLANS_DIR;
      const badDir = mkdtempSync(path.join(tmpdir(), "heating-bad-"));
      process.env.PLANS_DIR = badDir;
      try {
        mkdirSync(`${badDir}/.stats`, { recursive: true });
        writeFileSync(
          `${badDir}/.stats/heating-statistics.json`,
          JSON.stringify({ heatingOnPercentage: 50, cycleStart: "x", cycleEnd: "y" }),
        );
        const loaded = loadHeatingStatistics();
        assert.equal(loaded, null);
      } finally {
        process.env.PLANS_DIR = origDir;
        rmSync(badDir, { recursive: true, force: true });
      }
    });

    it("stats are persisted after buffer fills and tick fires", () => {
      const freshDir = mkdtempSync(path.join(tmpdir(), "heating-persist-"));
      const origDir = process.env.PLANS_DIR;
      process.env.PLANS_DIR = freshDir;
      try {
        const tracker = new HeatingTracker(defaultCfg, null);
        feedSamples(tracker, 0, 60, 1500);
        tracker.tick(makeDate(60 * MIN_MS));
        const persisted = loadHeatingStatistics();
        assert.notEqual(persisted, null);
        assert.equal(persisted!.sampleCount, 60);
      } finally {
        process.env.PLANS_DIR = origDir;
        rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });
});
