import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localDateTimeString } from "../src/utils/date-time-format.ts";
import { loadConfig, updateConfigWeeklySchedule } from "../src/config.ts";

// Point cache reads at the checked-in fixture files, never touch the network.
process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

const { plan, planFallbackSlot, computePlan } = await import("../src/ev-charging/planner.ts");
const { parseTargetTime, resolveTargetTime, planChargeStatesChanged, normalizeTimePayload } =
  await import("../src/ev-charging/helpers.ts");

// Fixed planning start: 2026-04-18 14:00 local (Helsinki, UTC+3).
// 12:00 has already passed, so target is next day → window: 2026-04-18T14:00 → 2026-04-19T12:00.
const FROM = new Date("2026-04-18T14:00:00");
const CONFIG = loadConfig();

const TARGET_TIME = parseTargetTime(CONFIG.evCharging.targetTime, FROM);
const TARGET_KWH = CONFIG.evCharging.targetKwh;
const POWER_KW = CONFIG.evCharging.powerKw!;

test("correct number of total and charge slots", async () => {
  const slots = await plan(FROM, TARGET_TIME, TARGET_KWH, POWER_KW, CONFIG);
  assert.equal(slots.length, 88, "total slots in window");
  assert.equal(
    slots.filter((s) => s.charge).length,
    10,
    "charge slots = ceil(7 kWh / 0.75 kWh per slot)",
  );
});

test("8 solar-free charge slots", async () => {
  const slots = await plan(FROM, TARGET_TIME, TARGET_KWH, POWER_KW, CONFIG);
  const freeCount = slots.filter((s) => s.charge && s.effectiveCostEur === 0).length;
  assert.equal(freeCount, 8);
});

test("total charging cost ~0.028 €", async () => {
  const slots = await plan(FROM, TARGET_TIME, TARGET_KWH, POWER_KW, CONFIG);
  const total = slots.filter((s) => s.charge).reduce((sum, s) => sum + s.effectiveCostEur, 0);
  assert.ok(Math.abs(total - 0.028) < 0.0005, `expected ~0.028 € but got ${total.toFixed(4)} €`);
});

test("selected charge slots are the cheapest 10 on 2026-04-19 morning", async () => {
  const slots = await plan(FROM, TARGET_TIME, TARGET_KWH, POWER_KW, CONFIG);
  const chargeTimes = slots.filter((s) => s.charge).map((s) => localDateTimeString(s.start));

  assert.deepEqual(chargeTimes, [
    "2026-04-19T09:30:00",
    "2026-04-19T09:45:00",
    "2026-04-19T10:00:00",
    "2026-04-19T10:15:00",
    "2026-04-19T10:30:00",
    "2026-04-19T10:45:00",
    "2026-04-19T11:00:00",
    "2026-04-19T11:15:00",
    "2026-04-19T11:30:00",
    "2026-04-19T11:45:00",
  ]);
});

test("every slot has spot price and solar forecast populated", async () => {
  const slots = await plan(FROM, TARGET_TIME, TARGET_KWH, POWER_KW, CONFIG);
  for (const s of slots) {
    assert.ok(s.spotPriceEurPerKwh >= 0, `negative spot price at ${s.start.toISOString()}`);
    assert.ok(s.solarForecastW >= 0, `negative solar at ${s.start.toISOString()}`);
  }
});

// ── 17:00 session planning (used by the MQTT integration tests) ───────────────
//
// FROM_EVENING = 2026-04-18T17:00, targetKwh=5, targetTime="12:00" (next day).
// Solar on Apr 19 peaks at >3500 W well above the 3 kW charger, so the
// 10:00–11:45 window is fully solar-free (0 €).

const FROM_EVENING = new Date("2026-04-18T17:00:00");
const CONFIG_5KWH = {
  ...CONFIG,
  evCharging: { ...CONFIG.evCharging, targetKwh: 5 },
};

test("17:00 session → 8 solar-free charge slots on Apr 19 at 10:00–12:00", async () => {
  const targetDate = parseTargetTime("12:00", FROM_EVENING); // next day 12:00
  const slots = await plan(FROM_EVENING, targetDate, 5, POWER_KW, CONFIG_5KWH);
  const chargeSlots = slots.filter((s) => s.charge);
  assert.equal(chargeSlots.length, 8, "8 slots: 7 needed + 1 extra solar-free");
  assert.equal(
    chargeSlots[0].start.toISOString().slice(0, 10),
    "2026-04-19",
    "charge slots are next day",
  );
  assert.equal(chargeSlots[0].start.getHours(), 10, "first slot at 10:00");
  assert.equal(chargeSlots[chargeSlots.length - 1].end.getHours(), 12, "last slot ends at 12:00");
  assert.equal(chargeSlots[chargeSlots.length - 1].end.getMinutes(), 0);
  assert.ok(
    chargeSlots.every((s) => s.effectiveCostEur === 0),
    "all slots solar-free",
  );
});

test("17:00 session, target=21:00 tonight → 7 cheap evening slots starting at 17:00", async () => {
  const targetDate = parseTargetTime("21:00", FROM_EVENING); // same day 21:00
  const slots = await plan(FROM_EVENING, targetDate, 5, POWER_KW, CONFIG_5KWH);
  const chargeSlots = slots.filter((s) => s.charge);
  assert.equal(chargeSlots.length, 7, "7 slots for 5 kWh at 3 kW");
  assert.ok(
    chargeSlots.every((s) => s.start.toISOString().slice(0, 10) === "2026-04-18"),
    "all slots on Apr 18",
  );
  assert.equal(chargeSlots[0].start.getHours(), 17, "first slot at 17:00 (session start)");
});

// ── planFallbackSlot tests ────────────────────────────────────────────────────
//
// Uses the same CACHE_DIR fixture. 2026-04-19 solar fixture: 3537 W at 10:00,
// 96 W at 06:00. Charger power = 3 kW. treeShadingSchedule starts at 13:00,
// so at 10:00 shading factor = 1.0.

test("fallback: solar covers load → reason 'solar'", async () => {
  // 10:00 on Apr 19: solar 3537 W >> 3 kW charger → gridFraction = 0
  const now = new Date("2026-04-19T10:00:00");
  const targetDate = new Date("2026-04-19T12:00:00");
  const decision = await planFallbackSlot(now, targetDate, 3, POWER_KW, CONFIG);
  assert.equal(decision.reason, "solar");
  assert.equal(decision.charge, true);
  assert.equal(decision.slotEnd.getTime(), new Date("2026-04-19T10:15:00").getTime());
});

test("fallback: not enough time to reach target → reason 'mustCharge'", async () => {
  // 14:00 on Apr 18 (solar 2125 W but that only shifts the grid fraction; with only
  // 2 slots to a 14:30 target and needing 4 slots for 3 kWh → mustCharge).
  // Use 06:00 Apr 18 where solar is 0 W to keep gridFraction = 1 (pure grid).
  const now = new Date("2026-04-18T06:00:00");
  const targetDate = new Date("2026-04-18T06:30:00"); // only 2 slots ahead
  const remainingKwh = 3; // needs ceil(3/0.75) = 4 slots, only 2 available
  const decision = await planFallbackSlot(now, targetDate, remainingKwh, POWER_KW, CONFIG);
  assert.equal(decision.reason, "mustCharge");
  assert.equal(decision.charge, true);
});

test("fallback: spot prices missing but plenty of time → reason 'waiting'", async () => {
  // 06:00 on Apr 18: solar = 0 W, gridFraction = 1.
  // Target is 12:00 next day → 120 slots to target, need 4 for 3 kWh → waiting.
  const now = new Date("2026-04-18T06:00:00");
  const targetDate = new Date("2026-04-19T12:00:00");
  const remainingKwh = 3; // needs 4 slots, 120 available → plenty of slack
  const decision = await planFallbackSlot(now, targetDate, remainingKwh, POWER_KW, CONFIG);
  assert.equal(decision.reason, "waiting");
  assert.equal(decision.charge, false);
  assert.ok(typeof decision.details === "string" && decision.details.length > 0);
});

// ── computePlan: past-slot exclusion ─────────────────────────────────────────
//
// Regression test for the Charge Now relay-flicker bug:
// When a past slot is cheaper than the current slot, it must not displace the
// current slot from the top-N selection (it should be excluded entirely).

test("computePlan: past slot is excluded and cannot displace the current charging slot", () => {
  const slotMs = 15 * 60 * 1000;
  const makeSlot = (isoStart: string, spotCph: number) => {
    const start = new Date(isoStart);
    return {
      start,
      end: new Date(start.getTime() + slotMs),
      spotPriceEurPerKwh: spotCph / 100,
      transportCostEurPerKwh: 0,
      solarForecastW: 0,
    };
  };

  // now = start of 08:45 slot; 08:30 slot has just expired
  const now = new Date("2026-04-19T08:45:00");
  const targetTime = new Date("2026-04-19T10:00:00");
  const fetchedSlots = [
    makeSlot("2026-04-19T08:30:00", 1), // past (cheapest!) — would steal a seat
    makeSlot("2026-04-19T08:45:00", 4), // current slot — most expensive of the rest
    makeSlot("2026-04-19T09:00:00", 2), // future
    makeSlot("2026-04-19T09:15:00", 3), // future
    makeSlot("2026-04-19T09:30:00", 5), // future
  ];

  // 0.75 kWh at 1 kW → slotsNeeded = 3
  // Bug: sorts all 5, picks cheapest 3 → {08:30, 09:00, 09:15}; 08:45 NOT charged
  // Fix: 08:30 is past → excluded; sorts 4, picks cheapest 3 → {09:00, 09:15, 08:45}; 08:45 charged
  const result = computePlan(fetchedSlots, 0.75, 1, targetTime, now);

  assert.equal(result.length, 4, "past slot 08:30 is not in the output");
  assert.ok(
    !result.some((s) => s.start.getTime() === new Date("2026-04-19T08:30:00").getTime()),
    "08:30 is excluded from the plan",
  );
  const current = result.find(
    (s) => s.start.getTime() === new Date("2026-04-19T08:45:00").getTime(),
  );
  assert.ok(current !== undefined, "current slot 08:45 is present in the plan");
  assert.ok(current!.charge, "current slot 08:45 is marked for charging");
});

// ── planChargeStatesChanged: slot expiry ──────────────────────────────────────

test("planChargeStatesChanged: expired slot dropping from plan is not a change", () => {
  const slotMs = 15 * 60 * 1000;
  const makeSlot = (isoStart: string, charge: boolean) => {
    const start = new Date(isoStart);
    return {
      start,
      end: new Date(start.getTime() + slotMs),
      spotPriceEurPerKwh: 0.05,
      transportCostEurPerKwh: 0,
      solarForecastW: 0,
      effectiveCostEur: 0.01,
      charge,
      canHold: false,
    };
  };

  const prev = [
    makeSlot("2026-04-19T09:00:00", true), // was charging — about to expire
    makeSlot("2026-04-19T09:15:00", true), // charging — still future
    makeSlot("2026-04-19T09:30:00", false), // not charging
  ];
  // 09:00 slot expired → dropped from the next plan
  const next = [makeSlot("2026-04-19T09:15:00", true), makeSlot("2026-04-19T09:30:00", false)];
  assert.equal(planChargeStatesChanged(prev, next), false, "expiry alone is not a change");

  // A real charge-state flip must still be detected
  const nextWithChange = [
    makeSlot("2026-04-19T09:15:00", false), // was charging, now not — CHANGE
    makeSlot("2026-04-19T09:30:00", false),
  ];
  assert.equal(planChargeStatesChanged(prev, nextWithChange), true, "charge flip is detected");
});

// ── resolveTargetTime ─────────────────────────────────────────────────────────
// Fixed reference: 2026-04-18T14:00:00 = Saturday 14:00 Helsinki time.
// Day indices: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat

test("resolveTargetTime: no schedule falls back to global (same as parseTargetTime)", () => {
  // Sat 14:00, global = 16:00 still ahead today → returns today 16:00
  const result = resolveTargetTime("16:00", undefined, FROM);
  const expected = parseTargetTime("16:00", FROM);
  assert.equal(result.getTime(), expected.getTime());
});

test("resolveTargetTime: no schedule, global already passed → next day", () => {
  // Sat 14:00, global = 12:00 already passed → returns Sun 12:00
  const result = resolveTargetTime("12:00", undefined, FROM);
  const expected = parseTargetTime("12:00", FROM);
  assert.equal(result.getTime(), expected.getTime());
});

test("resolveTargetTime: schedule entry for today, time still ahead → uses schedule time today", () => {
  // Sat 14:00, schedule has sat=16:00 → returns today (Sat) at 16:00
  const result = resolveTargetTime("12:00", { sat: "16:00" }, FROM);
  const expected = new Date(FROM);
  expected.setHours(16, 0, 0, 0);
  assert.equal(result.getTime(), expected.getTime());
});

test("resolveTargetTime: schedule entry for today but already passed → tomorrow's schedule", () => {
  // Sat 14:00, schedule has sat=10:00 (passed) and sun=11:00 → returns Sun at 11:00
  const result = resolveTargetTime("12:00", { sat: "10:00", sun: "11:00" }, FROM);
  const expected = new Date(FROM);
  expected.setDate(expected.getDate() + 1);
  expected.setHours(11, 0, 0, 0);
  assert.equal(result.getTime(), expected.getTime());
});

test("resolveTargetTime: schedule entry for today passed, no tomorrow entry → global on tomorrow", () => {
  // Sat 14:00, schedule has sat=10:00 (passed), no sun entry → returns Sun at global 12:00
  const result = resolveTargetTime("12:00", { sat: "10:00" }, FROM);
  const expected = new Date(FROM);
  expected.setDate(expected.getDate() + 1);
  expected.setHours(12, 0, 0, 0);
  assert.equal(result.getTime(), expected.getTime());
});

test("resolveTargetTime: only tomorrow has a schedule entry, today uses global (not passed)", () => {
  // Sat 14:00, schedule has sun=9:00, today global=16:00 still ahead → returns today at 16:00
  const result = resolveTargetTime("16:00", { sun: "9:00" }, FROM);
  const expected = new Date(FROM);
  expected.setHours(16, 0, 0, 0);
  assert.equal(result.getTime(), expected.getTime());
});

test("resolveTargetTime: H:MM short format is accepted", () => {
  // Sat 14:00, schedule has sat=9:00 short form (passed) → tomorrow sun uses global 12:00
  const result = resolveTargetTime("12:00", { sat: "9:00" }, FROM);
  const expected = new Date(FROM);
  expected.setDate(expected.getDate() + 1);
  expected.setHours(12, 0, 0, 0);
  assert.equal(result.getTime(), expected.getTime());
});

// ── normalizeTimePayload ──────────────────────────────────────────────────────

test("normalizeTimePayload: HH:MM passes through", () => {
  assert.equal(normalizeTimePayload("18:00"), "18:00");
});

test("normalizeTimePayload: strips seconds from HH:MM:SS", () => {
  assert.equal(normalizeTimePayload("18:00:00"), "18:00");
});

test("normalizeTimePayload: pads short hours", () => {
  assert.equal(normalizeTimePayload("8:00"), "08:00");
});

test("normalizeTimePayload: rejects malformed values", () => {
  assert.equal(normalizeTimePayload("18"), null);
  assert.equal(normalizeTimePayload(""), null);
  assert.equal(normalizeTimePayload("aa:bb"), null);
  assert.equal(normalizeTimePayload("24:00"), null);
  assert.equal(normalizeTimePayload("18:99"), null);
});

// ── updateConfigWeeklySchedule ────────────────────────────────────────────────

function makeTempConfig(initial: unknown): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evchargeboss-config-"));
  const file = path.join(dir, "config.json");
  writeFileSync(file, JSON.stringify(initial, null, 2));
  return file;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8"));
}

test("updateConfigWeeklySchedule: creates weeklySchedule with the new day, preserving other config", () => {
  const file = makeTempConfig({ evCharging: { targetTime: "12:00" }, solar: { kwp: 5 } });
  try {
    updateConfigWeeklySchedule(file, "mon", "18:30");
    const raw = readJson(file) as { evCharging: unknown; solar: unknown };
    assert.deepEqual(raw.evCharging, {
      targetTime: "12:00",
      weeklySchedule: { mon: "18:30" },
    });
    assert.deepEqual(raw.solar, { kwp: 5 });
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("updateConfigWeeklySchedule: preserves other days and overwrites the changed day", () => {
  const file = makeTempConfig({
    evCharging: { targetTime: "12:00", weeklySchedule: { sat: "10:00", mon: "12:00" } },
  });
  try {
    updateConfigWeeklySchedule(file, "mon", "18:30");
    const raw = readJson(file) as { evCharging: { weeklySchedule: Record<string, string> } };
    assert.deepEqual(raw.evCharging.weeklySchedule, { sat: "10:00", mon: "18:30" });
  } finally {
    rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

test("updateConfigWeeklySchedule: refuses to write config-example.json", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evchargeboss-config-"));
  const file = path.join(dir, "config-example.json");
  const original = JSON.stringify({ evCharging: { targetTime: "12:00" } }, null, 2);
  writeFileSync(file, original);
  try {
    updateConfigWeeklySchedule(file, "mon", "18:30");
    assert.equal(readFileSync(file, "utf8"), original);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
