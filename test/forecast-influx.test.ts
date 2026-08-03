/**
 * Integration tests for forecast-to-Influx logging in fetchSlots.
 *
 * Requires the InfluxDB container:
 *   docker compose up -d
 *
 * Uses future dates (2099-01-01) that have no local cache files to trigger
 * the "fresh" fetch path.  globalThis.fetch is temporarily replaced with a
 * strict mock that returns canned spot/solar data and THROWS on any
 * unrecognized URL - a real network request can never escape this file.
 * Actual writes go to the real InfluxDB and are verified with a Flux query.
 *
 * The EVCHARGEBOSS_NO_FETCH guard is set for the whole file and lifted only
 * around the single mocked fetchSlots call below.
 *
 * NOTE: CACHE_DIR in spot.ts/solar.ts is captured at module-load time, so the
 * env var cannot be overridden from within a test file.  Cache files for the
 * 2099-01-01 test date are therefore written to CWD (".") and cleaned up in
 * the after() hook.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchSlots } from "../src/electricity/index.ts";
import { loadConfig } from "../src/config.ts";
import { queryInflux, parseFluxCsv } from "../src/influx.ts";
import type { InfluxConfig } from "../src/influx.ts";

process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));
process.env.EVCHARGEBOSS_NO_FETCH = "1";
const CONFIG = loadConfig();

const INFLUX: InfluxConfig = {
  url: "http://localhost:8086",
  token: "test-token",
  org: "evchargeboss",
  bucket: "evchargeboss",
};

// Future date with no cache anywhere → always fresh on first call.
const DATE = "2099-01-01";
const FROM = new Date("2099-01-01T12:00:00"); // Helsinki local → 2 quarter-hour slots
const TO = new Date("2099-01-01T12:30:00");
const T0 = FROM.getTime();
const T1 = T0 + 15 * 60 * 1000;

// CACHE_DIR is "." (CWD) at module-load time; persist*Cache writes here.
const SPOT_CACHE = `.spot-cache-${DATE}.json`;
const SOLAR_CACHE = `.solar-cache-${DATE}.json`;

// Unique measurement names so test 1 and test 2 never share a namespace.
const EL_MEASUREMENT_FRESH = "test-forecast-el-fresh";
const SOL_MEASUREMENT_FRESH = "test-forecast-sol-fresh";
const EL_MEASUREMENT_CACHED = "test-forecast-el-cached";
const SOL_MEASUREMENT_CACHED = "test-forecast-sol-cached";

const elConfigFresh = {
  ...CONFIG.electricity,
  influx: { measurement: EL_MEASUREMENT_FRESH },
};
const solConfigFresh = {
  ...CONFIG.solar,
  influx: { measurement: SOL_MEASUREMENT_FRESH, tags: { unit: "W" } },
};
const elConfigCached = {
  ...CONFIG.electricity,
  influx: { measurement: EL_MEASUREMENT_CACHED },
};
const solConfigCached = {
  ...CONFIG.solar,
  influx: { measurement: SOL_MEASUREMENT_CACHED },
};

// ─── Fetch mock ───────────────────────────────────────────────────────────────

/** Render a Date as "YYYY-MM-DD HH:MM:SS" in local time (forecast.solar format). */
function fmtLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:00`
  );
}

/** Generate all 96 quarter-hour slot timestamps for a local-time date string "YYYY-MM-DD". */
function fullDaySlots(dateStr: string): number[] {
  const slots: number[] = [];
  for (let i = 0; i < 96; i++) {
    const h = Math.floor(i / 4);
    const m = (i % 4) * 15;
    const pad = (n: number) => String(n).padStart(2, "0");
    slots.push(new Date(`${dateStr}T${pad(h)}:${pad(m)}:00`).getTime());
  }
  return slots;
}

function installFetchMock(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const s = String(input);
    if (s.includes("spot-hinta.fi")) {
      // Return all 96 slots for DATE so persistSpotCache writes the cache file.
      const data = fullDaySlots(DATE).map((epoch, i) => ({
        Rank: i + 1,
        DateTime: new Date(epoch).toISOString(),
        PriceNoTax: 0.05,
        PriceWithTax: epoch === T0 ? 0.062 : epoch === T1 ? 0.055 : 0.05,
      }));
      return { ok: true, json: async () => data } as Response;
    }
    if (s.includes("forecast.solar")) {
      const watts: Record<string, number> = {
        [fmtLocal(new Date(T0))]: 500,
        [fmtLocal(new Date(T1))]: 600,
      };
      return {
        ok: true,
        json: async () => ({ result: { watts, watt_hours_period: {} } }),
      } as Response;
    }
    // No escape hatch: an unrecognized URL means a code path we do not mock,
    // so fail loudly offline rather than hit the real network.
    throw new Error(`Unexpected network fetch in forecast-influx test: ${s}`);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Poll InfluxDB for rows matching `measurement` at timestamp `epochMs`, up to 5 s. */
async function pollForRows(
  measurement: string,
  epochMs: number,
  timeoutMs = 5000,
): Promise<Record<string, string>[]> {
  const flux = `
    from(bucket: "${INFLUX.bucket}")
      |> range(start: 2098-01-01T00:00:00Z, stop: 2100-01-01T00:00:00Z)
      |> filter(fn: (r) => r._measurement == "${measurement}")
      |> filter(fn: (r) => r._time == ${new Date(epochMs).toISOString()})
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

// ─── Setup / teardown ─────────────────────────────────────────────────────────

before(async () => {
  // Verify InfluxDB is reachable.
  await queryInflux(INFLUX, `from(bucket: "${INFLUX.bucket}") |> range(start: -1s) |> limit(n: 1)`);
  // Remove any leftover cache files so test 1 always hits the fresh path.
  if (existsSync(SPOT_CACHE)) rmSync(SPOT_CACHE);
  if (existsSync(SOLAR_CACHE)) rmSync(SOLAR_CACHE);
});

after(() => {
  if (existsSync(SPOT_CACHE)) rmSync(SPOT_CACHE);
  if (existsSync(SOLAR_CACHE)) rmSync(SOLAR_CACHE);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

test("writes electricity and solar forecast to InfluxDB when data is fresh", async () => {
  const restoreFetch = installFetchMock();
  // The no-fetch guard must be lifted for the fresh path; the strict mock
  // above keeps this offline.
  delete process.env.EVCHARGEBOSS_NO_FETCH;
  try {
    const slots = await fetchSlots(FROM, TO, elConfigFresh, solConfigFresh, false, INFLUX);
    assert.equal(slots.length, 2, "should return 2 slots");
  } finally {
    process.env.EVCHARGEBOSS_NO_FETCH = "1";
    restoreFetch();
  }

  // Verify electricity row landed in InfluxDB.
  const elRows = await pollForRows(EL_MEASUREMENT_FRESH, T0);
  assert.ok(elRows.length > 0, "electricity row for T0 should appear in InfluxDB");
  const elRow = elRows.find((r) => r["_field"] === "value");
  assert.ok(elRow, "electricity row has value field");
  assert.equal(parseFloat(elRow!["_value"]), 0.062, "electricity T0 = spot price 0.062");

  // Verify solar row landed in InfluxDB.
  const solRows = await pollForRows(SOL_MEASUREMENT_FRESH, T0);
  assert.ok(solRows.length > 0, "solar row for T0 should appear in InfluxDB");
  const solRow = solRows.find((r) => r["_field"] === "value");
  assert.ok(solRow, "solar row has value field");
  assert.equal(parseFloat(solRow!["_value"]), 500, "solar T0 = 500 W");
  assert.equal(solRow!["unit"], "W", "solar row has unit tag");
});

test("does not write to InfluxDB when data is served from cache", async () => {
  // Cache files written by the previous test mean fresh=false → no write.
  assert.ok(existsSync(SPOT_CACHE), "spot cache should exist from previous test");

  // Use distinct measurement names that have never been written to.
  await fetchSlots(FROM, TO, elConfigCached, solConfigCached, false, INFLUX);

  // Allow async fire-and-forget to settle before querying.
  await new Promise<void>((r) => setTimeout(r, 500));

  const flux = `
    from(bucket: "${INFLUX.bucket}")
      |> range(start: 2098-01-01T00:00:00Z, stop: 2100-01-01T00:00:00Z)
      |> filter(fn: (r) => r._measurement == "${EL_MEASUREMENT_CACHED}" or r._measurement == "${SOL_MEASUREMENT_CACHED}")
  `;
  const csv = await queryInflux(INFLUX, flux);
  const rows = parseFluxCsv(csv);
  assert.equal(rows.length, 0, "no rows for cached measurements — nothing was written");
});
