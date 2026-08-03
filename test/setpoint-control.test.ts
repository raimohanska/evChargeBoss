import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../src/config.ts";
import { makeClock } from "../src/utils/timing-utils.ts";

// Point cache reads at the checked-in fixture files, never touch the network.
process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));
process.env.EVCHARGEBOSS_NO_FETCH = "1";

const { planSetpoint } = await import("../src/setpoint-control/planner.ts");
const { runSetpointControlLoop } = await import("../src/setpoint-control/index.ts");

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

describe("runSetpointControlLoop", () => {
  test("publishes one command per slot in order", async () => {
    const clock = makeClock(100_000, FROM);

    const published: { topic: string; payload: string }[] = [];
    const publish = (topic: string, payload: string) => published.push({ topic, payload });

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    await runSetpointControlLoop(FROM, SP_CONFIG, CONFIG, publish, clock, async () => fixedPlan);

    assert.equal(published.length, fixedPlan.length, "one publish per slot");
    for (let i = 0; i < fixedPlan.length; i++) {
      assert.equal(published[i].topic, SP_CONFIG.mqtt.commandTopic);
      assert.equal(published[i].payload, String(fixedPlan[i].setpoint));
    }
  });

  test("does not return before plan end (prevents outer-loop spin)", async () => {
    // Clock starts 5 minutes before the end of the window so almost all slots
    // are already past. The function must still wait until planEnd before returning.
    const fiveMinBeforeEnd = new Date(TO.getTime() - 5 * 60 * 1000);
    const clock = makeClock(100_000, fiveMinBeforeEnd);

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    const publish = () => {};
    await runSetpointControlLoop(
      fiveMinBeforeEnd,
      SP_CONFIG,
      CONFIG,
      publish,
      clock,
      async () => fixedPlan,
    );

    const planEnd = fixedPlan[fixedPlan.length - 1].end;
    assert.ok(
      clock.now().getTime() >= planEnd.getTime(),
      `expected clock to advance to planEnd (${planEnd.toISOString()}), got ${clock.now().toISOString()}`,
    );
  });
});

// ── Room temperature adjustment tests ────────────────────────────────────────

describe("runSetpointControlLoop room temperature adjustment", () => {
  const RT_CONFIG = {
    targetTemperature: 21,
    allowedDeviationUp: 1,
    allowedDeviationDown: 1,
    influence: 5,
    mqtt: { temperatureTopic: "test/room/temperature" },
  };

  const SP_CONFIG_RT = { ...SP_CONFIG, roomTemperature: RT_CONFIG };

  test("temperature below range raises setpoint by influence on every slot", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_topic: string, payload: string) => published.push(payload);

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    // 18°C < 21 − 1 = 20 → below range
    await runSetpointControlLoop(
      FROM,
      SP_CONFIG_RT,
      CONFIG,
      publish,
      clock,
      async () => fixedPlan,
      () => 18,
    );

    assert.equal(published.length, fixedPlan.length);
    for (let i = 0; i < fixedPlan.length; i++) {
      assert.equal(published[i], String(fixedPlan[i].setpoint + 5), `slot ${i}`);
    }
  });

  test("temperature above range lowers setpoint by influence on every slot", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_topic: string, payload: string) => published.push(payload);

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    // 23.5°C > 21 + 1 = 22 → above range
    await runSetpointControlLoop(
      FROM,
      SP_CONFIG_RT,
      CONFIG,
      publish,
      clock,
      async () => fixedPlan,
      () => 23.5,
    );

    assert.equal(published.length, fixedPlan.length);
    for (let i = 0; i < fixedPlan.length; i++) {
      assert.equal(published[i], String(fixedPlan[i].setpoint - 5), `slot ${i}`);
    }
  });

  test("temperature within range leaves setpoint unchanged", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_topic: string, payload: string) => published.push(payload);

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    // 21°C = target → within range
    await runSetpointControlLoop(
      FROM,
      SP_CONFIG_RT,
      CONFIG,
      publish,
      clock,
      async () => fixedPlan,
      () => 21,
    );

    assert.equal(published.length, fixedPlan.length);
    for (let i = 0; i < fixedPlan.length; i++) {
      assert.equal(published[i], String(fixedPlan[i].setpoint), `slot ${i}`);
    }
  });

  test("temperature unavailable leaves setpoint unchanged", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_topic: string, payload: string) => published.push(payload);

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    await runSetpointControlLoop(
      FROM,
      SP_CONFIG_RT,
      CONFIG,
      publish,
      clock,
      async () => fixedPlan,
      () => undefined,
    );

    assert.equal(published.length, fixedPlan.length);
    for (let i = 0; i < fixedPlan.length; i++) {
      assert.equal(published[i], String(fixedPlan[i].setpoint), `slot ${i}`);
    }
  });

  test("adjusted setpoint clamped to setpointMin", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_topic: string, payload: string) => published.push(payload);

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    // setpointMin=50: expensive slots (planned 40) + 5 = 45 < 50 → clamped to 50
    const spConfig = { ...SP_CONFIG_RT, setpointMin: 50 };
    // 18°C → below range → raise by 5
    await runSetpointControlLoop(
      FROM,
      spConfig,
      CONFIG,
      publish,
      clock,
      async () => fixedPlan,
      () => 18,
    );

    assert.equal(published.length, fixedPlan.length);
    for (let i = 0; i < fixedPlan.length; i++) {
      const expected = Math.max(fixedPlan[i].setpoint + 5, 50);
      assert.equal(published[i], String(expected), `slot ${i}: planned=${fixedPlan[i].setpoint}`);
    }
    const clampedCount = fixedPlan.filter((s) => s.setpoint + 5 < 50).length;
    assert.ok(clampedCount > 0, "expected at least one slot clamped to min");
  });

  test("adjusted setpoint clamped to setpointMax", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_topic: string, payload: string) => published.push(payload);

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    // setpointMax=68: cheap slots (planned 65) + 5 = 70 > 68 → clamped to 68
    const spConfig = { ...SP_CONFIG_RT, setpointMax: 68 };
    // 18°C → below range → raise by 5
    await runSetpointControlLoop(
      FROM,
      spConfig,
      CONFIG,
      publish,
      clock,
      async () => fixedPlan,
      () => 18,
    );

    assert.equal(published.length, fixedPlan.length);
    for (let i = 0; i < fixedPlan.length; i++) {
      const expected = Math.min(fixedPlan[i].setpoint + 5, 68);
      assert.equal(published[i], String(expected), `slot ${i}: planned=${fixedPlan[i].setpoint}`);
    }
    const clampedCount = fixedPlan.filter((s) => s.setpoint + 5 > 68).length;
    assert.ok(clampedCount > 0, "expected at least one slot clamped to max");
  });
});
