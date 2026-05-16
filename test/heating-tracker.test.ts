import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";

// MUST set PLANS_DIR before importing the module under test,
// because getStatsFilePath() captures process.env.PLANS_DIR at call time.
let tmpDir: string;
tmpDir = mkdtempSync(path.join(tmpdir(), "heating-tracker-test-"));
process.env.PLANS_DIR = tmpDir;

import {
  HeatingTracker,
  loadHeatingStatistics,
  saveHeatingStatistics,
} from "../src/ev-charging/heating-tracker.ts";

const CYCLE_MS = 24 * 60 * 60 * 1000;

function makeDate(offsetMs: number, base = new Date("2026-01-01T00:00:00")): Date {
  return new Date(base.getTime() + offsetMs);
}

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("HeatingTracker", () => {
  it("getLatest returns null when no persisted stats and no completed cycle", () => {
    const tracker = new HeatingTracker(null);
    tracker.onHoldChange(true, makeDate(0));
    tracker.tick(makeDate(CYCLE_MS - 1));
    assert.equal(tracker.getLatest(), null);
  });

  it("getLatest returns persisted stats before any cycle completes", () => {
    const persisted = {
      heatingOnPercentage: 42.5,
      cycleStart: "2026-01-01T00:00:00",
      cycleEnd: "2026-01-02T00:00:00",
    };
    const tracker = new HeatingTracker(persisted);
    tracker.onHoldChange(false, makeDate(0));
    tracker.tick(makeDate(CYCLE_MS - 1));
    assert.deepEqual(tracker.getLatest(), persisted);
  });

  it("computes 0% when heating never held during 24h cycle", () => {
    const tracker = new HeatingTracker(null);
    tracker.onHoldChange(false, makeDate(0));
    tracker.tick(makeDate(CYCLE_MS));
    const stats = tracker.getLatest();
    assert.notEqual(stats, null);
    assert.equal(stats!.heatingOnPercentage, 0);
  });

  it("computes 100% when heating held for entire 24h cycle", () => {
    const tracker = new HeatingTracker(null);
    tracker.onHoldChange(true, makeDate(0));
    tracker.tick(makeDate(CYCLE_MS));
    const stats = tracker.getLatest();
    assert.notEqual(stats, null);
    assert.equal(stats!.heatingOnPercentage, 100);
  });

  it("computes 50% when heating held for exactly 12 hours", () => {
    const tracker = new HeatingTracker(null);
    const base = new Date("2026-01-01T00:00:00");
    tracker.onHoldChange(true, makeDate(0, base)); // held from t=0
    tracker.onHoldChange(false, makeDate(12 * 3600_000, base)); // off at t=12h
    tracker.tick(makeDate(CYCLE_MS, base));
    const stats = tracker.getLatest();
    assert.notEqual(stats, null);
    assert.equal(stats!.heatingOnPercentage, 50);
  });

  it("computes percentage correctly with multiple events", () => {
    // held: 0h-6h (6h) + 18h-24h (6h) = 12h total = 50%
    const base = new Date("2026-01-01T00:00:00");
    const tracker = new HeatingTracker(null);
    tracker.onHoldChange(true, makeDate(0, base));
    tracker.onHoldChange(false, makeDate(6 * 3600_000, base));
    tracker.onHoldChange(true, makeDate(18 * 3600_000, base));
    tracker.tick(makeDate(CYCLE_MS, base));
    const stats = tracker.getLatest();
    assert.notEqual(stats, null);
    assert.equal(stats!.heatingOnPercentage, 50);
  });

  it("handles two completed 48h cycles via tick", () => {
    const base = new Date("2026-01-01T00:00:00");
    const tracker = new HeatingTracker(null);
    // First cycle: held 12h of 24h = 50%
    tracker.onHoldChange(true, makeDate(0, base));
    tracker.onHoldChange(false, makeDate(12 * 3600_000, base));
    // 48h later
    tracker.tick(makeDate(2 * CYCLE_MS, base));
    const stats = tracker.getLatest();
    assert.notEqual(stats, null);
    // Second cycle: heating was off (last state before cycleEnd was off)
    // so second cycle should be 0%; but latestStats is the last cycle computed
    assert.equal(stats!.heatingOnPercentage, 0);
  });

  it("carries held state across cycle boundary for continuity", () => {
    const base = new Date("2026-01-01T00:00:00");
    const tracker = new HeatingTracker(null);
    // Held the whole time — start at t=0 and never turn off
    tracker.onHoldChange(true, makeDate(0, base));
    // First cycle complete
    tracker.tick(makeDate(CYCLE_MS, base));
    const firstStats = tracker.getLatest();
    assert.equal(firstStats!.heatingOnPercentage, 100);
    // Second cycle complete — continuity seed carries held=true, still 100%
    tracker.tick(makeDate(2 * CYCLE_MS, base));
    const secondStats = tracker.getLatest();
    assert.equal(secondStats!.heatingOnPercentage, 100);
  });

  it("cycle completes when onHoldChange is called past 24h boundary", () => {
    const base = new Date("2026-01-01T00:00:00");
    const tracker = new HeatingTracker(null);
    tracker.onHoldChange(false, makeDate(0, base));
    // Event arrives after 24h have elapsed
    tracker.onHoldChange(true, makeDate(CYCLE_MS + 1000, base));
    const stats = tracker.getLatest();
    assert.notEqual(stats, null);
    assert.equal(stats!.heatingOnPercentage, 0);
  });

  it("persists stats to file and loadHeatingStatistics reads them back", () => {
    const stats = {
      heatingOnPercentage: 33.3,
      cycleStart: "2026-01-01T00:00:00",
      cycleEnd: "2026-01-02T00:00:00",
    };
    saveHeatingStatistics(stats);
    const loaded = loadHeatingStatistics();
    assert.deepEqual(loaded, stats);
  });

  it("loadHeatingStatistics returns null when file missing", () => {
    // Use a different PLANS_DIR for this check
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

  it("cycleStart and cycleEnd are included in persisted stats", () => {
    const base = new Date("2026-03-15T00:00:00");
    const tracker = new HeatingTracker(null);
    tracker.onHoldChange(false, base);
    tracker.tick(makeDate(CYCLE_MS, base));
    const stats = tracker.getLatest();
    assert.notEqual(stats, null);
    assert.match(stats!.cycleStart, /2026-03-15/);
    assert.match(stats!.cycleEnd, /2026-03-16/);
  });
});
