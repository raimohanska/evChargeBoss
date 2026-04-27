/**
 * Integration test: full MQTT charge session writes metrics to InfluxDB.
 *
 * Requires both Mosquitto and InfluxDB containers:
 *   docker compose up -d
 *
 * Uses the same 17:00 → 7 solar-free slots scenario as main-loop-mqtt.test.ts.
 * All 7 slots at 10:00–11:45 on Apr 19 are solar-free (effectiveCostEur=0)
 * and solar forecast exceeds the 3 kW charger, so expected results are:
 *   charged_kwh    = 7 slots × 0.75 kWh = 5.25 (plan-based, no energyField)
 *   total_cost_eur = 0
 *   solar_pct      = 100
 */

import { describe, test, before } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import type { MqttRelaySimulator } from "./helpers/mqtt-relay-simulator.ts";
import { FROM, SPEEDUP } from "./helpers/config.ts";
import { startMqttSession } from "./helpers/mqtt-session.ts";
import { writeSessionSummary, queryInflux, parseFluxCsv } from "../src/influx.ts";
import type { InfluxConfig } from "../src/influx.ts";

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

const INFLUX: InfluxConfig = {
  url: "http://localhost:8086",
  token: "test-token",
  org: "evchargeboss",
  bucket: "evchargeboss",
  tags: { location: "test-garage", charger_type: "ICU Compact Mini" },
};

/** Poll InfluxDB for the latest ev_charge_session row, retrying for up to 5 s. */
async function pollForRecord(timeoutMs = 5000): Promise<Record<string, string>[]> {
  const flux = `
    from(bucket: "${INFLUX.bucket}")
      |> range(start: -5m)
      |> filter(fn: (r) => r._measurement == "ev_charge_session")
      |> last()
  `;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const csv = await queryInflux(INFLUX, flux);
    const rows = parseFluxCsv(csv);
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 200));
  }
  return [];
}

/** Consume the three relay commands that mark arrival at the 10:00 solar charge window. */
async function advanceToSolarWindow(relay: MqttRelaySimulator): Promise<void> {
  await relay.assertOn("2026-04-18T17:00");
  await relay.assertOff("2026-04-19T10:00");
  await relay.assertOn("2026-04-19T10:00");
}

describe("InfluxDB integration", { concurrency: false }, () => {
  before(async () => {
    // Verify InfluxDB is reachable before running tests.
    const flux = `from(bucket: "${INFLUX.bucket}") |> range(start: -1s) |> limit(n: 1)`;
    await queryInflux(INFLUX, flux);
  });

  test("Session end writes charged_kwh, total_cost_eur, solar_pct to InfluxDB", async () => {
    const { loopPromise, relay, teardown } = await startMqttSession(
      FROM,
      SPEEDUP,
      {},
      {},
      (summary) => writeSessionSummary(INFLUX, summary),
    );
    try {
      await advanceToSolarWindow(relay);
      await loopPromise;
    } finally {
      teardown();
    }

    const rows = await pollForRecord();
    assert.ok(rows.length > 0, "Expected at least one InfluxDB record after session");

    const byField = Object.fromEntries(rows.map((r) => [r["_field"], r["_value"]]));

    assert.equal(
      parseFloat(byField["charged_kwh"]),
      5.25,
      `charged_kwh: expected 5.25, got ${byField["charged_kwh"]}`,
    );
    assert.equal(
      parseFloat(byField["total_cost_eur"]),
      0,
      `total_cost_eur: expected 0, got ${byField["total_cost_eur"]}`,
    );
    assert.equal(
      parseInt(byField["solar_pct"], 10),
      100,
      `solar_pct: expected 100, got ${byField["solar_pct"]}`,
    );
  });
});
