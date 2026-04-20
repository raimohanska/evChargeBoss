import assert from "node:assert/strict";
import { localDateTimeString } from "../src/utils.ts";

const TOLERANCE_MS = 10 * 60_000; // 10 virtual minutes — absorbs MQTT roundtrip jitter

/**
 * Assert that a relay event time is within 10 virtual minutes of an expected local datetime.
 * expectedDateTime format: "YYYY-MM-DDTHH:MM"
 */
export function assertAt(actual: Date, expectedDateTime: string, label: string): void {
  const expected = new Date(`${expectedDateTime}:00`);
  assert.ok(
    Math.abs(actual.getTime() - expected.getTime()) < TOLERANCE_MS,
    `${label}: got ${localDateTimeString(actual)}, expected ~${expectedDateTime}`,
  );
}

/** Assert that a relay event time is strictly before an expected local datetime. */
export function assertBefore(actual: Date, expectedDateTime: string, label: string): void {
  const expected = new Date(`${expectedDateTime}:00`);
  assert.ok(
    actual < expected,
    `${label}: got ${localDateTimeString(actual)}, expected before ${expectedDateTime}`,
  );
}
