/**
 * Unit tests for runSlot (charger.ts) and shouldSuppressStatus (mqtt-status.ts).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runSlot } from "../src/ev-charging/charger.ts";
import type { HoldSource } from "../src/ev-charging/charger.ts";
import type { Slot } from "../src/ev-charging/types.ts";
import { STATUS, shouldSuppressStatus } from "../src/ev-charging/mqtt-status.ts";
import { makeClock } from "../src/utils/timing-utils.ts";

// ---------------------------------------------------------------------------
// shouldSuppressStatus — tests for the status-stuck-after-gap bug
// ---------------------------------------------------------------------------

describe("shouldSuppressStatus", () => {
  test("Charging until X → Waiting for charging to start is suppressed (consecutive slots)", () => {
    assert.equal(
      shouldSuppressStatus("Charging until 16:15", STATUS.waitingForChargingToStart),
      true,
    );
  });

  test("Charging until X → Planned charge start at Y is NOT suppressed (real gap)", () => {
    assert.equal(
      shouldSuppressStatus("Charging until 16:15", STATUS.plannedChargeStart("18:00")),
      false,
    );
  });

  test("Charging until X → Charging paused (heating peak) is NOT suppressed", () => {
    assert.equal(shouldSuppressStatus("Charging until 16:15", STATUS.heatingHold), false);
  });

  test("Planned charge start at X → same value is suppressed (no duplicate)", () => {
    assert.equal(
      shouldSuppressStatus(STATUS.plannedChargeStart("10:00"), STATUS.plannedChargeStart("10:00")),
      true,
    );
  });

  test("Planned charge start at X → different time is NOT suppressed", () => {
    assert.equal(
      shouldSuppressStatus(STATUS.plannedChargeStart("10:00"), STATUS.plannedChargeStart("12:00")),
      false,
    );
  });

  test("Charging until X → Idle is NOT suppressed", () => {
    assert.equal(shouldSuppressStatus("Charging until 11:45", STATUS.idle), false);
  });
});

// ---------------------------------------------------------------------------
// runSlot — tests for the hold-doesn't-pause-relay bug
// ---------------------------------------------------------------------------

const SPEEDUP = 100_000;

function makeSlot(overrides: Partial<Slot> = {}): Slot {
  const now = new Date("2026-01-01T10:00:00");
  return {
    start: now,
    end: new Date(now.getTime() + 15 * 60_000),
    spotPriceEurPerKwh: 0.1,
    transportCostEurPerKwh: 0.05,
    solarForecastW: 0,
    effectiveCostEur: 0.037,
    charge: true,
    canHold: false,
    ...overrides,
  };
}

describe("runSlot — heating hold", () => {
  test("hold pauses relay even when canHold=false (heating active from slot start)", async () => {
    const slot = makeSlot({ canHold: false });
    const clock = makeClock(SPEEDUP, slot.start);

    const commands: boolean[] = [];
    const driver = {
      async send(on: boolean) {
        commands.push(on);
      },
    };

    // Heating is already on when the slot starts → subscribe fires cb(true) immediately.
    const holdSource: HoldSource = {
      subscribe(cb) {
        cb(true);
        return () => {};
      },
    };

    await runSlot({
      slot,
      chargeRunEnd: slot.end,
      driver,
      publisher: undefined,
      signal: undefined,
      wattsSource: undefined,
      holdSource,
      prevChargedKwh: 0,
      powerThresholdW: 10,
      powerKw: 3,
      clock,
    });

    assert.ok(
      commands.includes(false),
      `Expected relay OFF during heating hold (canHold=false). Commands: ${JSON.stringify(commands)}`,
    );
    assert.ok(
      !commands.includes(true),
      `Relay should NOT have been turned ON (heating was on the whole slot). Commands: ${JSON.stringify(commands)}`,
    );
  });

  test("hold pauses and resumes relay mid-slot (canHold=false)", async () => {
    const slot = makeSlot({ canHold: false });
    const clock = makeClock(SPEEDUP, slot.start);

    const commands: boolean[] = [];
    const driver = {
      async send(on: boolean) {
        commands.push(on);
      },
    };

    let holdCb: ((held: boolean) => void) | null = null;
    const holdSource: HoldSource = {
      subscribe(cb) {
        holdCb = cb;
        cb(false); // not held at start → relay ON
        return () => {
          holdCb = null;
        };
      },
    };

    // Fire hold and release mid-slot.
    // 3 ms real ≈ 300 s virtual at 100 000× — comfortably within the 900 s slot.
    setTimeout(() => holdCb?.(true), 3);
    setTimeout(() => holdCb?.(false), 6);

    await runSlot({
      slot,
      chargeRunEnd: slot.end,
      driver,
      publisher: undefined,
      signal: undefined,
      wattsSource: undefined,
      holdSource,
      prevChargedKwh: 0,
      powerThresholdW: 10,
      powerKw: 3,
      clock,
    });

    assert.deepEqual(
      commands,
      [true, false, true],
      `Expected ON → OFF → ON. Got: ${JSON.stringify(commands)}`,
    );
  });

  test("hold also pauses relay when canHold=true (no regression)", async () => {
    const slot = makeSlot({ canHold: true });
    const clock = makeClock(SPEEDUP, slot.start);

    const commands: boolean[] = [];
    const driver = {
      async send(on: boolean) {
        commands.push(on);
      },
    };

    const holdSource: HoldSource = {
      subscribe(cb) {
        cb(true); // heating active from start
        return () => {};
      },
    };

    await runSlot({
      slot,
      chargeRunEnd: slot.end,
      driver,
      publisher: undefined,
      signal: undefined,
      wattsSource: undefined,
      holdSource,
      prevChargedKwh: 0,
      powerThresholdW: 10,
      powerKw: 3,
      clock,
    });

    assert.ok(
      commands.includes(false),
      `Expected relay OFF for canHold=true slot too. Commands: ${JSON.stringify(commands)}`,
    );
  });
});
