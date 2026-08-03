/**
 * Unit tests for src/electricity/poller.ts.
 *
 * The porssisahko.net fallback returns a rolling ~48 h window that starts
 * ~01:00 Finnish local time, so today's 00:00-00:45 slots are permanently
 * missing. The poller must not loop forever on that: it should fetch the
 * available suffix and cache what it can.
 *
 * All network access is mocked; the solar cache is pre-seeded so only spot
 * prices are fetched live. EVCHARGEBOSS_NO_FETCH guards the rest.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// CACHE_DIR is captured at module load by poller.ts/spot.ts/solar.ts, so it
// must be set before the dynamic import below.
const CACHE_DIR = mkdtempSync(path.join(os.tmpdir(), "electricity-poller-"));
process.env.CACHE_DIR = CACHE_DIR;
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));
process.env.EVCHARGEBOSS_NO_FETCH = "1";

const { runElectricityPollOnce } = await import("../src/electricity/poller.ts");
const { readCache, writeCache } = await import("../src/electricity/cache.ts");
const { makeClock } = await import("../src/utils/timing-utils.ts");
const { makeTestConfig } = await import("./helpers/config.ts");

const NOW = new Date("2026-08-03T23:12:00");

interface PorssisahkoEntry {
  price: number;
  startDate: string;
  endDate: string;
}

// Rolling-window fallback response: covers 01:00 today -> 00:45 day after
// tomorrow, missing today's 00:00-00:45 slots exactly like porssisahko.net v2.
const PORS_WINDOW: PorssisahkoEntry[] = [];
for (let t = new Date("2026-08-03T01:00:00"); t <= new Date("2026-08-05T00:45:00"); ) {
  PORS_WINDOW.push({
    price: 10,
    startDate: new Date(t).toISOString(),
    endDate: new Date(t.getTime() + 15 * 60 * 1000).toISOString(),
  });
  t = new Date(t.getTime() + 15 * 60 * 1000);
}

const origFetch = globalThis.fetch;
globalThis.fetch = async (
  input: string | URL | Request,
  _init?: RequestInit,
): Promise<Response> => {
  const s = String(input);
  if (s.includes("spot-hinta.fi")) return { ok: false, status: 429 } as Response;
  if (s.includes("porssisahko.net"))
    return { ok: true, json: async () => ({ prices: PORS_WINDOW }) } as Response;
  throw new Error(`Unexpected network fetch in poller test: ${s}`);
};

after(() => {
  globalThis.fetch = origFetch;
  rmSync(CACHE_DIR, { recursive: true, force: true });
});

test("recovers when the fallback source lacks today's leading slots", async () => {
  const config = makeTestConfig();
  const clock = makeClock(1, NOW);

  // Seed solar caches so only spot prices are fetched live (mocked above).
  writeCache(`${CACHE_DIR}/.solar-cache-2026-08-03.json`, {});
  writeCache(`${CACHE_DIR}/.solar-cache-2026-08-04.json`, {});

  delete process.env.EVCHARGEBOSS_NO_FETCH;
  try {
    await runElectricityPollOnce(config, clock);
  } finally {
    process.env.EVCHARGEBOSS_NO_FETCH = "1";
  }

  const tomorrow = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-2026-08-04.json`);
  assert.ok(tomorrow, "tomorrow's spot cache is written");
  assert.equal(Object.keys(tomorrow).length, 96);

  const today = readCache<Record<string, number>>(`${CACHE_DIR}/.spot-cache-2026-08-03.json`);
  assert.ok(today, "today's partial spot cache is written");
  assert.equal(Object.keys(today).length, 92);
});
