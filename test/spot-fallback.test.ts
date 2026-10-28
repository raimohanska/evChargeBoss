/**
 * Unit tests for the spot-price provider fallback in src/electricity/spot.ts.
 *
 * - porssisahko.net v2 (quarter-hourly, cents/kWh incl. VAT) is used when
 *   api.spot-hinta.fi fails (HTTP 429, 5xx, network error).
 * - All network access is mocked; EVCHARGEBOSS_NO_FETCH is set for the whole
 *   file and lifted only around the mocked calls, so a real request cannot
 *   escape.
 *
 * CACHE_DIR is pointed at a fresh temp dir (created before the dynamic import
 * of spot.ts, which captures it at module load), so the "missing cache"
 * branch is always taken.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), "spot-fallback-"));
process.env.CACHE_DIR = CACHE_DIR;
process.env.EVCHARGEBOSS_NO_FETCH = "1";

const { fetchSpotPrices, persistSpotCache } = await import("../src/electricity/spot.ts");
const { readCache, writeCache } = await import("../src/electricity/cache.ts");
const { localDateString, localDateTimeString } = await import("../src/utils/date-time-format.ts");

// Future date with no cache file anywhere → the fresh fetch path.
const DATE = "2099-01-01";
const T0 = new Date(`${DATE}T00:00:00`).getTime();
const T95 = new Date(`${DATE}T23:45:00`).getTime();

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 96 quarter-hour slots for a local-time date string "YYYY-MM-DD". */
function fullDaySlots(dateStr: string): number[] {
  const slots: number[] = [];
  for (let i = 0; i < 96; i++) {
    slots.push(new Date(`${dateStr}T${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}:00`).getTime());
  }
  return slots;
}

// porssisahko.net v2 response: price in cents/kWh, timestamps ISO 8601 UTC.
const PORSSISAHKO_DAY = fullDaySlots(DATE).map((epoch, i) => ({
  price: 5 + i,
  startDate: new Date(epoch).toISOString(),
  endDate: new Date(epoch + 15 * 60 * 1000).toISOString(),
}));

// api.spot-hinta.fi response: PriceWithTax in €/kWh, DateTime local (no tz).
const SPOT_HINTA_DAY = fullDaySlots(DATE).map((epoch, i) => ({
  Rank: i + 1,
  DateTime: new Date(epoch).toISOString(),
  PriceNoTax: 0.04,
  PriceWithTax: 0.05 + i * 0.001,
}));

interface FetchStub {
  spotHinta: () => Response | Promise<Response>;
  porssisahkoOk: boolean;
}

/** Replace globalThis.fetch with a strict stub; unknown URLs throw. */
function installFetchStub(stub: FetchStub): () => void {
  const orig = globalThis.fetch;
  globalThis.fetch = async (
    input: string | URL | Request,
    _init?: RequestInit,
  ): Promise<Response> => {
    const s = String(input);
    if (s.includes("spot-hinta.fi")) return await stub.spotHinta();
    if (s.includes("porssisahko.net")) {
      if (!stub.porssisahkoOk) return { ok: false, status: 503 } as Response;
      return { ok: true, json: async () => ({ prices: PORSSISAHKO_DAY }) } as Response;
    }
    throw new Error(`Unexpected network fetch in spot-fallback test: ${s}`);
  };
  return () => {
    globalThis.fetch = orig;
  };
}

/** Call fetchSpotPrices with the offline guard lifted (fetch is mocked). */
async function fetchSpotPricesFresh(dates: string[]) {
  delete process.env.EVCHARGEBOSS_NO_FETCH;
  try {
    return await fetchSpotPrices(dates);
  } finally {
    process.env.EVCHARGEBOSS_NO_FETCH = "1";
  }
}

after(() => {
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

test("falls back to porssisahko.net when spot-hinta.fi returns 429", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const restore = installFetchStub({
    spotHinta: async () => ({ ok: false, status: 429 }) as Response,
    porssisahkoOk: true,
  });
  try {
    const { map, fresh } = await fetchSpotPricesFresh([DATE]);
    assert.equal(fresh, true);
    assert.equal(map.size, 96, "all 96 quarter-hour slots present");
    // price is cents/kWh → divided by 100 into €/kWh.
    assert.equal(map.get(T0), 0.05, "first slot: 5 cents = 0.05 EUR/kWh");
    assert.equal(map.get(T95), 1.0, "last slot: 100 cents = 1.00 EUR/kWh");
    assert.equal(logs.mock.callCount(), 1);
    assert.ok(
      String(logs.mock.calls[0].arguments[0]).endsWith(
        "Spot prices fetched from porssisahko.net: 96 slots, covering 2099-01-01T00:00:00 to 2099-01-02T00:00:00; primary failed: spot-hinta.fi HTTP 429",
      ),
    );
  } finally {
    restore();
  }
});

test("uses spot-hinta.fi prices as-is when it responds OK", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const restore = installFetchStub({
    spotHinta: async () => ({ ok: true, json: async () => SPOT_HINTA_DAY }) as Response,
    porssisahkoOk: true,
  });
  try {
    const { map, fresh } = await fetchSpotPricesFresh([DATE]);
    assert.equal(fresh, true);
    assert.equal(map.size, 96);
    // PriceWithTax is already €/kWh → used directly, no /100 conversion.
    assert.equal(map.get(T0), 0.05, "first slot = PriceWithTax 0.05");
    assert.equal(map.get(T95), 0.05 + 95 * 0.001, "last slot = PriceWithTax 0.145");
    assert.equal(logs.mock.callCount(), 1);
    assert.ok(
      String(logs.mock.calls[0].arguments[0]).endsWith(
        "Spot prices fetched from api.spot-hinta.fi: 96 slots, covering 2099-01-01T00:00:00 to 2099-01-02T00:00:00",
      ),
    );
  } finally {
    restore();
  }
});

test("throws when both spot-hinta.fi and porssisahko.net fail", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const restore = installFetchStub({
    spotHinta: async () => ({ ok: false, status: 429 }) as Response,
    porssisahkoOk: false,
  });
  try {
    await assert.rejects(fetchSpotPricesFresh([DATE]), /porssisahko\.net HTTP 503/);
    assert.equal(logs.mock.callCount(), 1);
    assert.ok(
      String(logs.mock.calls[0].arguments[0]).endsWith(
        "Spot price fetch failed: api.spot-hinta.fi (spot-hinta.fi HTTP 429); porssisahko.net (porssisahko.net HTTP 503)",
      ),
    );
  } finally {
    restore();
  }
});

test("failure summary identifies providers and flattens multiline errors", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const fallbackError = new Error("connection failed\nplease retry");
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    if (String(input).includes("spot-hinta.fi")) throw new Error("network\ntimeout");
    if (String(input).includes("porssisahko.net")) throw fallbackError;
    throw new Error(`Unexpected network fetch: ${String(input)}`);
  });
  await assert.rejects(fetchSpotPricesFresh([DATE]), (err) => err === fallbackError);
  assert.equal(logs.mock.callCount(), 1);
  assert.ok(
    String(logs.mock.calls[0].arguments[0]).endsWith(
      "Spot price fetch failed: api.spot-hinta.fi (network timeout); porssisahko.net (connection failed please retry)",
    ),
  );
});

test("fallback summary identifies incomplete requested dates", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const restore = installFetchStub({
    spotHinta: async () => ({ ok: false, status: 404 }) as Response,
    porssisahkoOk: true,
  });
  try {
    await fetchSpotPricesFresh([DATE, "2099-01-02"]);
    assert.equal(logs.mock.callCount(), 1);
    assert.ok(
      String(logs.mock.calls[0].arguments[0]).endsWith(
        "Spot prices fetched from porssisahko.net: 96 slots, covering 2099-01-01T00:00:00 to 2099-01-02T00:00:00; requested dates incomplete: 2099-01-02; primary failed: spot-hinta.fi HTTP 404",
      ),
    );
  } finally {
    restore();
  }
});

test("summary detects gaps within coverage and stays single-line in verbose mode", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const restore = installFetchStub({
    spotHinta: async () =>
      ({ ok: true, json: async () => SPOT_HINTA_DAY.filter((_, i) => i !== 4) }) as Response,
    porssisahkoOk: true,
  });
  delete process.env.EVCHARGEBOSS_NO_FETCH;
  try {
    await fetchSpotPrices([DATE], true);
    assert.equal(logs.mock.callCount(), 1);
    assert.match(
      String(logs.mock.calls[0].arguments[0]),
      /95 slots, covering .*; requested dates incomplete: 2099-01-01$/,
    );
  } finally {
    process.env.EVCHARGEBOSS_NO_FETCH = "1";
    restore();
  }
});

test("empty response reports no coverage and incomplete dates", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const restore = installFetchStub({
    spotHinta: async () => ({ ok: true, json: async () => [] }) as Response,
    porssisahkoOk: true,
  });
  try {
    await fetchSpotPricesFresh([DATE]);
    assert.equal(logs.mock.callCount(), 1);
    assert.ok(
      String(logs.mock.calls[0].arguments[0]).endsWith(
        "Spot prices fetched from api.spot-hinta.fi: 0 slots, no coverage; requested dates incomplete: 2099-01-01",
      ),
    );
  } finally {
    restore();
  }
});

test("persistSpotCache writes a partial cache for the current day but skips partial other days", () => {
  const today = localDateString(new Date());
  const map = new Map<number, number>();
  // 92 slots from 01:00 today, like the porssisahko.net rolling window.
  for (let i = 0; i < 92; i++) {
    map.set(new Date(`${today}T01:00:00`).getTime() + i * 15 * 60 * 1000, 0.05);
  }
  // A short partial day that must still be skipped.
  for (let i = 0; i < 10; i++) {
    map.set(new Date(`2099-12-31T10:00:00`).getTime() + i * 15 * 60 * 1000, 0.05);
  }

  persistSpotCache(map);

  const todayCached = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-${today}.json`);
  assert.ok(todayCached, "today's cache is written even though it is partial");
  assert.equal(Object.keys(todayCached).length, 92);
  assert.equal(
    readCache(`${CACHE_DIR}/.spot-cache-2099-12-31.json`),
    null,
    "partial non-today day is still skipped",
  );
});

test("fetchSpotPrices serves a partial current-day cache without any network access", async (t) => {
  const logs = t.mock.method(console, "log", () => {});
  const today = localDateString(new Date());
  const partial: Record<string, number> = {};
  for (let i = 0; i < 92; i++) {
    const d = new Date(`${today}T01:00:00`);
    d.setMinutes(d.getMinutes() + i * 15);
    partial[localDateTimeString(d)] = 0.05;
  }
  writeCache(`${CACHE_DIR}/.spot-cache-${today}.json`, partial);

  // EVCHARGEBOSS_NO_FETCH stays set: accepting the partial cache must not
  // attempt any network access.
  const { map, fresh } = await fetchSpotPrices([today]);
  assert.equal(fresh, false);
  assert.equal(map.size, 92);
  assert.equal(logs.mock.callCount(), 0);
});
