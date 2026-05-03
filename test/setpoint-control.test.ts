import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { planSetpoint } from "../src/setpoint-control/planner.ts";
import { runSetpointControlLoop } from "../src/setpoint-control/index.ts";
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

const SP_CONFIG = {
  name: "Water Heater",
  setpointDefault: 51,
  setpointCheap: 65,
  setpointExpensive: 40,
  cheapFactor: 0.5,
  expensiveFactor: 1.5,
  solarWattsThresholdForCheap: 2000,
  mqtt: { commandTopic: "test/water-heater/set" },
};

const CONFIG = {
  ...BASE_CONFIG,
  setpointControl: { waterHeating: SP_CONFIG },
};

// ── Planner tests ─────────────────────────────────────────────────────────────

test("planSetpoint returns 96 slots for a 24h window", async () => {
  const slots = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
  assert.equal(slots.length, 96);
});

test("slots above solarWattsThresholdForCheap get setpointCheap", async () => {
  const slots = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
  for (const slot of slots) {
    if (slot.solarForecastW >= SP_CONFIG.solarWattsThresholdForCheap) {
      assert.equal(
        slot.setpoint,
        SP_CONFIG.setpointCheap,
        `solar slot at ${slot.start.toISOString()} (${slot.solarForecastW} W) should be cheap`,
      );
    }
  }
});

test("slot assignment matches the cheap-factor algorithm", async () => {
  const slots = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);

  // Re-derive prices the same way the planner does.
  const prices = slots.map((s) =>
    s.solarForecastW >= SP_CONFIG.solarWattsThresholdForCheap
      ? 0
      : s.spotPriceEurPerKwh + s.transportCostEurPerKwh,
  );
  const dailyAvg = prices.reduce((a, b) => a + b, 0) / prices.length;

  for (let i = 0; i < slots.length; i++) {
    let expectedSetpoint: number;
    if (prices[i] === 0 || prices[i] < dailyAvg * SP_CONFIG.cheapFactor) {
      expectedSetpoint = SP_CONFIG.setpointCheap;
    } else if (
      SP_CONFIG.expensiveFactor != null &&
      SP_CONFIG.setpointExpensive != null &&
      prices[i] > dailyAvg * SP_CONFIG.expensiveFactor
    ) {
      expectedSetpoint = SP_CONFIG.setpointExpensive;
    } else {
      expectedSetpoint = SP_CONFIG.setpointDefault;
    }
    assert.equal(
      slots[i].setpoint,
      expectedSetpoint,
      `slot ${i} at ${slots[i].start.toISOString()}: price=${prices[i].toFixed(4)} avg=${dailyAvg.toFixed(4)}`,
    );
  }
});

test("mix of cheap and default slots", async () => {
  const slots = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
  const cheapCount = slots.filter((s) => s.setpoint === SP_CONFIG.setpointCheap).length;
  const defaultCount = slots.filter((s) => s.setpoint === SP_CONFIG.setpointDefault).length;
  assert.ok(cheapCount > 0, "expected at least one cheap slot");
  assert.ok(defaultCount > 0, "expected at least one default slot");
});

test("expensive tier: slots above expensiveFactor * avg get setpointExpensive", async () => {
  // Use a low expensiveFactor so at least some slots are above it.
  const spConfig = { ...SP_CONFIG, expensiveFactor: 0.8 };
  const slots = await planSetpoint(FROM, TO, spConfig, CONFIG);
  const expensiveCount = slots.filter((s) => s.setpoint === spConfig.setpointExpensive).length;
  assert.ok(expensiveCount > 0, "expected at least one expensive slot with expensiveFactor=0.8");
});

// ── Execution loop tests ──────────────────────────────────────────────────────

test("runSetpointControlLoop publishes one command per slot in order", async () => {
  // Run at 100 000× speed so 24 h of slots complete in about 1 s.
  const clock = makeClock(100_000, FROM);

  const published: { topic: string; payload: string }[] = [];
  const publish = (topic: string, payload: string) => published.push({ topic, payload });

  await runSetpointControlLoop(FROM, SP_CONFIG, CONFIG, publish, clock);

  const expectedSlots = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);

  assert.equal(published.length, expectedSlots.length, "one publish per slot");
  for (let i = 0; i < expectedSlots.length; i++) {
    assert.equal(published[i].topic, SP_CONFIG.mqtt.commandTopic);
    assert.equal(published[i].payload, String(expectedSlots[i].setpoint));
  }
});
