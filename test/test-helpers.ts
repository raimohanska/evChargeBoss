import assert from "node:assert/strict";
import { localDateTimeString } from "../src/utils.ts";

const TOLERANCE_MS = 10 * 60_000; // 10 virtual minutes — absorbs MQTT roundtrip jitter

/** Assert that a relay event time is within TOLERANCE_MS of a local HH:MM on 2026-04-18. */
export function assertAt(actual: Date, expectedTime: string, label: string): void {
  const expected = new Date(`2026-04-18T${expectedTime}:00`);
  assert.ok(
    Math.abs(actual.getTime() - expected.getTime()) < TOLERANCE_MS,
    `${label}: got ${localDateTimeString(actual)}, expected ~${expectedTime}`,
  );
}

export function assertBefore(actual: Date, expectedTime: string, label: string): void {
  const expected = new Date(`2026-04-18T${expectedTime}:00`);
  assert.ok(
    actual < expected,
    `${label}: got ${localDateTimeString(actual)}, expected before ${expectedTime}`,
  );
}
