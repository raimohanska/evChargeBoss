import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { planWaterHeating } from "../src/water-heating/planner.ts";
import { runWaterHeatingLoop } from "../src/water-heating/index.ts";
import { loadConfig } from "../src/config.ts";
import { makeClock } from "../src/utils/timing-utils.ts";

// Point cache reads at the checked-in fixture files, never touch the network.
process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

// Fixed planning start: 2026-04-18 14:00 local (Helsinki, UTC+3).
// 24-hour window: 2026-04-18T14:00 → 2026-04-19T14:00 = 96 slots.
const FROM = new Date("2026-04-18T14:00:00");
const WINDOW_MS = 24 * 60 * 60 * 1000;
const TO = new Date(FROM.getTime() + WINDOW_MS);

const BASE_CONFIG = loadConfig();
const CONFIG = {
  ...BASE_CONFIG,
  waterHeating: {
    targetTemperatureDefault: 45,
    targetTemperatureCheap: 65,
    cheapFactor: 0.5,
    solarWattsThresholdForCheap: 2000,
    mqtt: { commandTopic: "test/water-heater/set" },
  },
};

// ── Planner tests ─────────────────────────────────────────────────────────────

test("planWaterHeating returns 96 slots for a 24h window", async () => {
  const slots = await planWaterHeating(FROM, TO, CONFIG);
  assert.equal(slots.length, 96);
});

test("slots above solarWattsThresholdForCheap get targetTemperatureCheap", async () => {
  const slots = await planWaterHeating(FROM, TO, CONFIG);
  for (const slot of slots) {
    if (slot.solarForecastW >= CONFIG.waterHeating.solarWattsThresholdForCheap) {
      assert.equal(
        slot.targetTemp,
        CONFIG.waterHeating.targetTemperatureCheap,
        `solar slot at ${slot.start.toISOString()} (${slot.solarForecastW} W) should be cheap`,
      );
    }
  }
});

test("slot assignment matches the cheap-factor algorithm", async () => {
  const slots = await planWaterHeating(FROM, TO, CONFIG);

  // Re-derive prices the same way the planner does.
  const prices = slots.map((s) =>
    s.solarForecastW >= CONFIG.waterHeating.solarWattsThresholdForCheap
      ? 0
      : s.spotPriceEurPerKwh + s.transportCostEurPerKwh,
  );
  const dailyAvg = prices.reduce((a, b) => a + b, 0) / prices.length;

  for (let i = 0; i < slots.length; i++) {
    const expectedTemp =
      prices[i] === 0 || prices[i] < dailyAvg * CONFIG.waterHeating.cheapFactor
        ? CONFIG.waterHeating.targetTemperatureCheap
        : CONFIG.waterHeating.targetTemperatureDefault;
    assert.equal(
      slots[i].targetTemp,
      expectedTemp,
      `slot ${i} at ${slots[i].start.toISOString()}: price=${prices[i].toFixed(4)} avg=${dailyAvg.toFixed(4)}`,
    );
  }
});

test("mix of cheap and default slots", async () => {
  const slots = await planWaterHeating(FROM, TO, CONFIG);
  const cheapCount = slots.filter(
    (s) => s.targetTemp === CONFIG.waterHeating.targetTemperatureCheap,
  ).length;
  assert.ok(cheapCount > 0, "expected at least one cheap slot");
  assert.ok(cheapCount < slots.length, "expected at least one default slot");
});

// ── Execution loop tests ──────────────────────────────────────────────────────

test("runWaterHeatingLoop publishes one command per slot in order", async () => {
  // Run at 100 000× speed so 24 h of slots complete in about 1 s.
  const clock = makeClock(100_000, FROM);

  const published: { topic: string; payload: string }[] = [];
  const publish = (topic: string, payload: string) => published.push({ topic, payload });

  await runWaterHeatingLoop(FROM, CONFIG, publish, clock);

  const expectedSlots = await planWaterHeating(FROM, TO, CONFIG);

  assert.equal(published.length, expectedSlots.length, "one publish per slot");
  for (let i = 0; i < expectedSlots.length; i++) {
    assert.equal(published[i].topic, CONFIG.waterHeating.mqtt.commandTopic);
    assert.equal(published[i].payload, String(expectedSlots[i].targetTemp));
  }
});
