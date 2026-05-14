import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { localDateTimeString } from "../src/utils/date-time-format.ts";
import { loadConfig } from "../src/config.ts";

// Point cache reads at the checked-in fixture files, never touch the network.
process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

const { plan, planFallbackSlot } = await import("../src/ev-charging/planner.ts");
const { parseTargetTime } = await import("../src/ev-charging/coordinator.ts");

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
