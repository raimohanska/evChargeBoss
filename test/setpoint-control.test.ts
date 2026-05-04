import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { planSetpoint } from "../src/setpoint-control/planner.ts";
import { runSetpointControlLoop } from "../src/setpoint-control/index.ts";
import type { SetpointSlot } from "../src/setpoint-control/types.ts";
import { loadConfig } from "../src/config.ts";
import { makeClock } from "../src/utils/timing-utils.ts";
import { IncompleteDataError } from "../src/electricity/IncompleteDataError.ts";

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

describe("runSetpointControlLoop", () => {
  // planFn that returns the portion of fixedPlan relevant to `from`.
  // Simulates a rolling re-plan: each call returns slots starting from the
  // current time, so currentPlan[0] always holds the current slot's setpoint.
  function makeSlicingPlanFn(fixedPlan: SetpointSlot[]): typeof planSetpoint {
    return async (from: Date) => {
      const aligned = new Date(from);
      aligned.setMinutes(Math.floor(aligned.getMinutes() / 15) * 15, 0, 0);
      const idx = fixedPlan.findIndex((s) => s.start.getTime() >= aligned.getTime());
      return idx >= 0 ? fixedPlan.slice(idx) : [fixedPlan[fixedPlan.length - 1]];
    };
  }

  test("publishes one command per slot in order", async () => {
    const clock = makeClock(100_000, FROM);

    const published: { topic: string; payload: string }[] = [];
    const publish = (topic: string, payload: string) => published.push({ topic, payload });

    const fixedPlan = await planSetpoint(FROM, TO, SP_CONFIG, CONFIG);
    await runSetpointControlLoop(
      FROM,
      SP_CONFIG,
      CONFIG,
      publish,
      clock,
      makeSlicingPlanFn(fixedPlan),
    );

    assert.equal(published.length, fixedPlan.length, "one publish per slot");
    for (let i = 0; i < fixedPlan.length; i++) {
      assert.equal(published[i].topic, SP_CONFIG.mqtt.commandTopic);
      assert.equal(published[i].payload, String(fixedPlan[i].setpoint));
    }
  });

  test("keeps current plan when re-plan fails with IncompleteDataError", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_: string, payload: string) => published.push(payload);

    // Use a 3-slot plan; subsequent re-plans all fail.
    const fixedSlots = (await planSetpoint(FROM, TO, SP_CONFIG, CONFIG)).slice(0, 3);
    let calls = 0;
    const planFn = async (): Promise<SetpointSlot[]> => {
      if (calls++ === 0) return fixedSlots;
      throw new IncompleteDataError("prices not available yet", []);
    };

    await runSetpointControlLoop(FROM, SP_CONFIG, CONFIG, publish, clock, planFn);

    assert.deepEqual(
      published,
      fixedSlots.map((s) => String(s.setpoint)),
    );
  });

  test("uses fresh setpoints when re-plan succeeds at each slot", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_: string, payload: string) => published.push(payload);

    const makeSlots = (setpoints: number[], base: Date): SetpointSlot[] =>
      setpoints.map((setpoint, i) => {
        const start = new Date(base.getTime() + i * 15 * 60 * 1000);
        return {
          start,
          end: new Date(start.getTime() + 15 * 60 * 1000),
          setpoint,
          costTier: "average",
          spotPriceEurPerKwh: 0.05,
          transportCostEurPerKwh: 0.045,
          solarForecastW: 0,
        };
      });

    const s1 = FROM;
    const s2 = new Date(FROM.getTime() + 15 * 60 * 1000);

    // plans[0] = initial (2 slots); plans[1] = re-plan at slot 0; plans[2] = re-plan at slot 1.
    const plans = [
      makeSlots([11, 22], s1), // initial
      makeSlots([33, 44], s1), // re-plan at slot 0 → publish 33
      makeSlots([55, 66], s2), // re-plan at slot 1 → publish 55
    ];
    let call = 0;
    const planFn = async (): Promise<SetpointSlot[]> => plans[call++] ?? plans[plans.length - 1];

    await runSetpointControlLoop(FROM, SP_CONFIG, CONFIG, publish, clock, planFn);

    assert.deepEqual(published, ["33", "55"]);
  });

  test("falls back to last good plan then resumes fresh plans", async () => {
    const clock = makeClock(100_000, FROM);
    const published: string[] = [];
    const publish = (_: string, payload: string) => published.push(payload);

    const makeSlots = (setpoints: number[], base: Date): SetpointSlot[] =>
      setpoints.map((setpoint, i) => {
        const start = new Date(base.getTime() + i * 15 * 60 * 1000);
        return {
          start,
          end: new Date(start.getTime() + 15 * 60 * 1000),
          setpoint,
          costTier: "average",
          spotPriceEurPerKwh: 0.05,
          transportCostEurPerKwh: 0.045,
          solarForecastW: 0,
        };
      });

    const s1 = FROM;
    const s2 = new Date(FROM.getTime() + 15 * 60 * 1000);
    const s3 = new Date(FROM.getTime() + 30 * 60 * 1000);

    // initial: [A, B, C]; re-plan at slot 0: [X, Y, Z]; slot 1: fail; slot 2: [P, Q, R]
    const results: Array<SetpointSlot[] | Error> = [
      makeSlots([10, 20, 30], s1), // initial
      makeSlots([11, 22, 33], s1), // re-plan slot 0 → publish 11
      new IncompleteDataError("missing", []), // re-plan slot 1 → keep last plan[1] = 22
      makeSlots([99, 88], s3), // re-plan slot 2 → publish 99
    ];
    let call = 0;
    const planFn = async (): Promise<SetpointSlot[]> => {
      const r = results[call++];
      if (r instanceof Error) throw r;
      return r;
    };

    await runSetpointControlLoop(FROM, SP_CONFIG, CONFIG, publish, clock, planFn);

    assert.deepEqual(published, ["11", "22", "99"]);
  });
});
