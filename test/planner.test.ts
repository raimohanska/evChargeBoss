import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { plan } from "../src/planner.ts";
import { localDateTimeString } from "../src/utils.ts";

// Point cache reads at the checked-in fixture files, never touch the network.
process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));

// Fixed planning start: 2026-04-18 10:00 local (Helsinki, UTC+3).
// Window: 2026-04-18T10:00 → 2026-04-19T12:00. Both days are in fixtures.
const FROM = new Date("2026-04-18T10:00:00");

test("correct number of total and charge slots", async () => {
  const slots = await plan(FROM);
  assert.equal(slots.length, 104, "total slots in window");
  assert.equal(slots.filter((s) => s.charge).length, 10, "charge slots = ceil(7 kWh / 0.75 kWh per slot)");
});

test("8 solar-free charge slots", async () => {
  const slots = await plan(FROM);
  const freeCount = slots.filter((s) => s.charge && s.effectiveCostEur === 0).length;
  assert.equal(freeCount, 8);
});

test("total charging cost ~0.028 €", async () => {
  const slots = await plan(FROM);
  const total = slots.filter((s) => s.charge).reduce((sum, s) => sum + s.effectiveCostEur, 0);
  assert.ok(
    Math.abs(total - 0.028) < 0.0005,
    `expected ~0.028 € but got ${total.toFixed(4)} €`
  );
});

test("selected charge slots are the cheapest 10 on 2026-04-19 morning", async () => {
  const slots = await plan(FROM);
  const chargeTimes = slots
    .filter((s) => s.charge)
    .map((s) => localDateTimeString(s.start));

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
  const slots = await plan(FROM);
  for (const s of slots) {
    assert.ok(s.spotPriceEurPerKwh >= 0, `negative spot price at ${s.start.toISOString()}`);
    assert.ok(s.solarForecastW >= 0, `negative solar at ${s.start.toISOString()}`);
  }
});
