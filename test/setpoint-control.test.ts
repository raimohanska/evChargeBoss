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
  expensiveFactor: 1.5,
  defaultPowerConsumptionW: 2000,
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

test("cheap count is at most expensive count", async () => {
  const slots = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
  const cheapCount = slots.filter((s) => s.costTier === "cheap").length;
  const expensiveCount = slots.filter((s) => s.costTier === "expensive").length;
  assert.ok(
    cheapCount <= expensiveCount,
    `cheapCount (${cheapCount}) should be <= expensiveCount (${expensiveCount})`,
  );
  assert.ok(cheapCount > 0, "expected at least some cheap slots");
});

test("slot assignment matches the energy-cost algorithm", async () => {
  const slots = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);

  // Re-derive slot costs the same way the planner does.
  const slotHours = 0.25;
  const deviceKwh = (SP_CONFIG.defaultPowerConsumptionW * slotHours) / 1000;
  const costs = slots.map((s) => {
    const solarKwh = (s.solarForecastW * slotHours) / 1000;
    return (deviceKwh - solarKwh) * (s.spotPriceEurPerKwh + s.transportCostEurPerKwh);
  });
  const avgCost = costs.reduce((a, b) => a + b, 0) / costs.length;
  const threshold = avgCost * SP_CONFIG.expensiveFactor;

  const expensiveIndices = new Set(
    costs
      .map((c, i) => ({ c, i }))
      .filter(({ c }) => c > threshold)
      .map(({ i }) => i),
  );
  const n = expensiveIndices.size;
  const cheapIndices = new Set(
    costs
      .map((c, i) => ({ c, i }))
      .filter(({ i }) => !expensiveIndices.has(i))
      .sort((a, b) => a.c - b.c)
      .slice(0, n)
      .map(({ i }) => i),
  );

  for (let i = 0; i < slots.length; i++) {
    let expectedTier: string;
    let expectedSetpoint: number;
    if (expensiveIndices.has(i)) {
      expectedTier = "expensive";
      expectedSetpoint = SP_CONFIG.setpointExpensive;
    } else if (cheapIndices.has(i)) {
      expectedTier = "cheap";
      expectedSetpoint = SP_CONFIG.setpointCheap;
    } else {
      expectedTier = "average";
      expectedSetpoint = SP_CONFIG.setpointDefault;
    }
    assert.equal(
      slots[i].costTier,
      expectedTier,
      `slot ${i} at ${slots[i].start.toISOString()}: cost=${costs[i].toFixed(5)} avg=${avgCost.toFixed(5)}`,
    );
    assert.equal(slots[i].setpoint, expectedSetpoint);
  }
});

test("mix of cheap, average and expensive slots with low expensiveFactor", async () => {
  // Use expensiveFactor=0.8 so at least some slots are above avg*0.8.
  const spConfig = { ...SP_CONFIG, expensiveFactor: 0.8 };
  const slots = await planSetpoint(FROM, TO, spConfig, CONFIG);
  const cheapCount = slots.filter((s) => s.costTier === "cheap").length;
  const expensiveCount = slots.filter((s) => s.costTier === "expensive").length;
  assert.ok(expensiveCount > 0, "expected at least one expensive slot with expensiveFactor=0.8");
  assert.ok(
    cheapCount <= expensiveCount,
    `cheapCount (${cheapCount}) should be <= expensiveCount (${expensiveCount})`,
  );
  assert.ok(cheapCount > 0, "expected some cheap slots");
});

test("no cheap/expensive when expensiveFactor absent", async () => {
  const spConfig = { ...SP_CONFIG, expensiveFactor: undefined, setpointExpensive: undefined };
  const slots = await planSetpoint(FROM, TO, spConfig, CONFIG);
  assert.ok(
    slots.every((s) => s.costTier === "average" && s.setpoint === SP_CONFIG.setpointDefault),
    "without expensiveFactor all slots should be average/default",
  );
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
