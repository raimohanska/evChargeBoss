/**
 * Tests for forecast-to-Influx logging in fetchSlots.
 *
 * Uses future dates (2099-01-01) that have no local cache files to trigger
 * the "fresh" fetch path.  A local HTTP server captures the Influx write
 * requests.  globalThis.fetch is temporarily replaced to return canned
 * spot/solar data without hitting the real APIs.
 *
 * Cache files written to CWD by persistSpotCache/persistSolarCache are
 * cleaned up in the after() hook and reused in the "cached" test.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fetchSlots } from "../src/electricity/index.ts";
import { loadConfig } from "../src/config.ts";

process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));
const CONFIG = loadConfig();

// Future date: no local cache file exists → fetchSpotPrices/fetchSolarForecast
// will call the real fetch and return fresh=true.
const DATE = "2099-01-01";
const FROM = new Date("2099-01-01T00:00:00"); // Helsinki local time → 2 slots
const TO = new Date("2099-01-01T00:30:00");
const T0 = FROM.getTime();
const T1 = T0 + 15 * 60 * 1000;

// Cache files written to CACHE_DIR = "." (CWD) by persist*Cache.
const SPOT_CACHE = `.spot-cache-${DATE}.json`;
const SOLAR_CACHE = `.solar-cache-${DATE}.json`;

const electricityWithInflux = {
  ...CONFIG.electricity,
  influx: { measurement: "electricity-cost-forecast", tags: { unit: "Eur/kWh" } },
};
const solarWithInflux = {
  ...CONFIG.solar,
  influx: { measurement: "power-forecast", tags: { device: "solar", unit: "W" } },
};

// ─── Local HTTP server to capture Influx write requests ───────────────────────

const capturedBodies: string[] = [];
const bodyCallbacks: Array<() => void> = [];

const influxServer = createServer((req, res) => {
  let data = "";
  req.on("data", (chunk) => (data += chunk));
  req.on("end", () => {
    capturedBodies.push(data);
    res.writeHead(204);
    res.end();
    bodyCallbacks.shift()?.(); // notify the next waiting promise
  });
});

/** Returns a Promise that resolves when the server receives the next body. */
function nextBody(): Promise<void> {
  return new Promise((resolve) => bodyCallbacks.push(resolve));
}

let influxPort: number;

before(async () => {
  await new Promise<void>((resolve) => influxServer.listen(0, "127.0.0.1", resolve));
  influxPort = (influxServer.address() as AddressInfo).port;
  // Clean up any leftover cache files from a previous test run.
  if (existsSync(SPOT_CACHE)) rmSync(SPOT_CACHE);
  if (existsSync(SOLAR_CACHE)) rmSync(SOLAR_CACHE);
});

after(() => {
  influxServer.close();
  if (existsSync(SPOT_CACHE)) rmSync(SPOT_CACHE);
  if (existsSync(SOLAR_CACHE)) rmSync(SOLAR_CACHE);
});

// ─── Fetch mock ───────────────────────────────────────────────────────────────

/** Render a Date as "YYYY-MM-DD HH:MM:SS" in local time (forecast.solar format). */
function fmtLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    ` ${pad(d.getHours())}:${pad(d.getMinutes())}:00`
  );
}

function installFetchMock(): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const s = String(input);
    if (s.includes("spot-hinta.fi")) {
      const data = [
        { Rank: 1, DateTime: new Date(T0).toISOString(), PriceNoTax: 0.05, PriceWithTax: 0.062 },
        { Rank: 2, DateTime: new Date(T1).toISOString(), PriceNoTax: 0.044, PriceWithTax: 0.055 },
      ];
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
    return orig(input as string);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

test("writes electricity and solar forecast to influx when data is fresh", async () => {
  const restoreFetch = installFetchMock();
  try {
    capturedBodies.length = 0;
    const influxConfig = {
      url: `http://127.0.0.1:${influxPort}`,
      token: "test",
      org: "test",
      bucket: "test",
    };

    // Register listeners before the call so they are queued when writes arrive.
    const recv1 = nextBody();
    const recv2 = nextBody();

    const slots = await fetchSlots(
      FROM,
      TO,
      electricityWithInflux,
      solarWithInflux,
      false,
      influxConfig,
    );
    assert.equal(slots.length, 2, "should return 2 slots");

    // Wait for both fire-and-forget HTTP writes to reach the local server.
    await recv1;
    await recv2;

    assert.equal(capturedBodies.length, 2, "should have written 2 bodies (electricity + solar)");

    const elBody = capturedBodies.find((b) => b.startsWith("electricity-cost-forecast"))!;
    const solBody = capturedBodies.find((b) => b.startsWith("power-forecast"))!;

    assert.ok(elBody, "electricity body present");
    assert.ok(solBody, "solar body present");
    assert.equal(elBody.split("\n").length, 2, "one line per slot in electricity body");
    assert.ok(elBody.includes("unit=Eur/kWh"), "electricity tag present");
    assert.ok(elBody.includes("value=0.062"), "first slot price in electricity body");
    assert.ok(elBody.includes(String(T0)), "T0 timestamp in electricity body");
    assert.ok(solBody.includes("unit=W"), "solar tag present");
    assert.ok(solBody.includes("value=500"), "first slot watts in solar body");
  } finally {
    restoreFetch();
  }
});

test("does not write to influx when data is served from cache", async () => {
  // Cache files for DATE were written by the previous test (persistSpotCache /
  // persistSolarCache).  fetchSpotPrices/fetchSolarForecast will read from
  // cache → fresh=false → no Influx write.
  assert.ok(existsSync(SPOT_CACHE), "spot cache should exist from previous test");

  capturedBodies.length = 0;
  const influxConfig = {
    url: `http://127.0.0.1:${influxPort}`,
    token: "test",
    org: "test",
    bucket: "test",
  };

  const slots = await fetchSlots(
    FROM,
    TO,
    electricityWithInflux,
    solarWithInflux,
    false,
    influxConfig,
  );
  assert.equal(slots.length, 2);

  // Allow time for any spurious async writes.
  await new Promise<void>((r) => setTimeout(r, 50));
  assert.equal(capturedBodies.length, 0, "no writes when data comes from cache");
});

test("does not write to influx when influx config is absent", async () => {
  // Still cached → no network call needed, and no influx config → no write.
  capturedBodies.length = 0;

  await fetchSlots(FROM, TO, electricityWithInflux, solarWithInflux, false, undefined);

  await new Promise<void>((r) => setTimeout(r, 50));
  assert.equal(capturedBodies.length, 0, "no writes when influx config is not provided");
});
