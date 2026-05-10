/**
 * Unit tests for runSlot (charger.ts) and shouldSuppressStatus (mqtt-status.ts).
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { runSlot, makeHoldAwareDriver } from "../src/ev-charging/charger.ts";
import type { HoldSource, ChargerDriver } from "../src/ev-charging/charger.ts";
import type { Slot } from "../src/ev-charging/types.ts";
import { STATUS, shouldSuppressStatus } from "../src/ev-charging/mqtt-status.ts";
import { makeClock, Canceller } from "../src/utils/timing-utils.ts";

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
  test("hold active from start: relay never turns ON and no spurious OFF command either", async () => {
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

    // Relay was never on, so no commands should have been sent at all.
    assert.deepEqual(
      commands,
      [],
      `Expected no relay commands (relay was never on). Got: ${JSON.stringify(commands)}`,
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

    // Relay was never on, so no commands should have been sent.
    assert.deepEqual(
      commands,
      [],
      `Expected no relay commands (relay was never on). Got: ${JSON.stringify(commands)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// makeHoldAwareDriver — unit tests
// ---------------------------------------------------------------------------

function makeDriver(): { commands: boolean[]; driver: ChargerDriver } {
  const commands: boolean[] = [];
  return {
    commands,
    driver: {
      async send(on: boolean) {
        commands.push(on);
      },
    },
  };
}

function makeHoldSource(initialHeld: boolean): {
  holdSource: HoldSource;
  fire(held: boolean): void;
} {
  let cb: ((held: boolean) => void) | null = null;
  const holdSource: HoldSource = {
    subscribe(callback) {
      cb = callback;
      callback(initialHeld);
      return () => {
        cb = null;
      };
    },
  };
  return { holdSource, fire: (held) => cb?.(held) };
}

describe("makeHoldAwareDriver", () => {
  test("send(true) when not held: relay turns ON", async () => {
    const { commands, driver } = makeDriver();
    const { holdSource } = makeHoldSource(false);
    const h = makeHoldAwareDriver(driver, holdSource, { onHeld() {}, onReleased() {} });
    await h.driver.send(true);
    assert.deepEqual(commands, [true]);
    h.dispose();
  });

  test("send(true) when held from start: no relay command at all", async () => {
    const { commands, driver } = makeDriver();
    const { holdSource } = makeHoldSource(true);
    const h = makeHoldAwareDriver(driver, holdSource, { onHeld() {}, onReleased() {} });
    await h.driver.send(true);
    // Relay was never on — no ON command and no spurious OFF command.
    assert.deepEqual(commands, [], `Expected no relay commands, got: ${JSON.stringify(commands)}`);
    h.dispose();
  });

  test("send(false) when held: no relay command (relay already off)", async () => {
    const { commands, driver } = makeDriver();
    const { holdSource } = makeHoldSource(true);
    const h = makeHoldAwareDriver(driver, holdSource, { onHeld() {}, onReleased() {} });
    await h.driver.send(false);
    assert.deepEqual(commands, [], `Expected no relay command, got: ${JSON.stringify(commands)}`);
    h.dispose();
  });

  test("hold fires while relay not requested: no relay command, no callback", () => {
    const { commands, driver } = makeDriver();
    const { holdSource, fire } = makeHoldSource(false);
    let heldCalls = 0;
    const h = makeHoldAwareDriver(driver, holdSource, {
      onHeld() {
        heldCalls++;
      },
      onReleased() {},
    });
    fire(true); // heating on, but send(true) was never called
    assert.deepEqual(commands, [], "Expected no relay command when not charging");
    assert.equal(heldCalls, 0, "Expected no onHeld callback when not charging");
    h.dispose();
  });

  test("hold starts mid-charge: relay turns OFF and onHeld is called", async () => {
    const { commands, driver } = makeDriver();
    const { holdSource, fire } = makeHoldSource(false);
    let heldCalls = 0;
    const h = makeHoldAwareDriver(driver, holdSource, {
      onHeld() {
        heldCalls++;
      },
      onReleased() {},
    });
    await h.driver.send(true); // relay ON
    fire(true); // heating starts
    assert.deepEqual(
      commands,
      [true, false],
      `Expected ON then OFF, got: ${JSON.stringify(commands)}`,
    );
    assert.equal(heldCalls, 1);
    h.dispose();
  });

  test("hold releases after pause: relay turns back ON and onReleased is called", async () => {
    const { commands, driver } = makeDriver();
    const { holdSource, fire } = makeHoldSource(false);
    let releasedCalls = 0;
    const h = makeHoldAwareDriver(driver, holdSource, {
      onHeld() {},
      onReleased() {
        releasedCalls++;
      },
    });
    await h.driver.send(true); // relay ON
    fire(true); // heating starts → relay OFF
    fire(false); // heating ends → relay back ON
    assert.deepEqual(
      commands,
      [true, false, true],
      `Expected ON→OFF→ON, got: ${JSON.stringify(commands)}`,
    );
    assert.equal(releasedCalls, 1);
    h.dispose();
  });

  test("hold fires while held from start, then releases: relay turns ON", async () => {
    const { commands, driver } = makeDriver();
    const { holdSource, fire } = makeHoldSource(true);
    const h = makeHoldAwareDriver(driver, holdSource, { onHeld() {}, onReleased() {} });
    await h.driver.send(true); // heating on → no ON sent
    fire(false); // heating ends → relay should turn ON
    assert.deepEqual(
      commands,
      [true],
      `Expected ON after release, got: ${JSON.stringify(commands)}`,
    );
    h.dispose();
  });

  test("isHeld getter reflects current state", () => {
    const { driver } = makeDriver();
    const { holdSource, fire } = makeHoldSource(false);
    const h = makeHoldAwareDriver(driver, holdSource, { onHeld() {}, onReleased() {} });
    assert.equal(h.isHeld, false);
    fire(true);
    assert.equal(h.isHeld, true);
    fire(false);
    assert.equal(h.isHeld, false);
    h.dispose();
  });
});

// ---------------------------------------------------------------------------
// runSlot — energy-on-abort (prorated estimate when no energyField)
// ---------------------------------------------------------------------------

describe("runSlot — energy on abort", () => {
  test("returns prorated kWh (not zero) when slot is aborted mid-way (no energyField)", async () => {
    const slot = makeSlot({ charge: true });
    const clock = makeClock(SPEEDUP, slot.start);

    const driver = { async send(_on: boolean) {} };
    const canceller = new Canceller();

    // Abort after ~50 % of the 15-minute slot: 450 000 ms virtual = 4.5 ms real at 100 000×.
    // Use 5 ms real to give a comfortable margin above the MQTT roundtrip noise floor.
    setTimeout(() => canceller.abort(), 5);

    const result = await runSlot({
      slot,
      chargeRunEnd: slot.end,
      driver,
      publisher: undefined,
      signal: canceller.signal,
      wattsSource: undefined,
      holdSource: undefined,
      prevChargedKwh: 0,
      powerThresholdW: 10,
      powerKw: 3,
      clock,
    });

    // kwh must reflect elapsed time, not be zeroed on abort.
    assert.ok(result.kwh > 0, `Expected kwh > 0 on abort, got ${result.kwh}`);
    assert.ok(result.kwh < 0.75, `Expected kwh < full-slot 0.75 kWh, got ${result.kwh}`);
  });

  test("returns full 0.75 kWh when slot runs to completion (no energyField)", async () => {
    const slot = makeSlot({ charge: true });
    const clock = makeClock(SPEEDUP, slot.start);

    const driver = { async send(_on: boolean) {} };

    const result = await runSlot({
      slot,
      chargeRunEnd: slot.end,
      driver,
      publisher: undefined,
      signal: undefined,
      wattsSource: undefined,
      holdSource: undefined,
      prevChargedKwh: 0,
      powerThresholdW: 10,
      powerKw: 3,
      clock,
    });

    assert.ok(Math.abs(result.kwh - 0.75) < 0.01, `Expected kwh ≈ 0.75, got ${result.kwh}`);
  });
});
