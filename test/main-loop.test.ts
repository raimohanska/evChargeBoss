import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';
import type { Config } from '../src/config.ts';
import { makeSimulateSession } from '../src/charger.ts';
import { createPublisher } from '../src/mqtt-status.ts';
import { makeClock } from '../src/utils.ts';
import { runMainLoop } from '../src/main-loop.ts';
import { IncompleteDataError } from '../src/errors.ts';
import { STATUS } from '../src/mqtt-status.ts';

process.env.CACHE_DIR = fileURLToPath(new URL('./fixtures', import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(
  new URL('./fixtures/config.json', import.meta.url),
);

// Planning from 2026-04-18T10:00 → target 12:00 same day (8 slots, all in cache).
const FROM = new Date('2026-04-18T10:00:00');
const SPEEDUP = 10_000;

function makeTestConfig(): Config {
  return {
    ...loadConfig(),
    test: { timeSpeedupFactor: SPEEDUP, justOnce: true },
  };
}

function errorStatus(err: unknown): string {
  if (err instanceof IncompleteDataError) return STATUS.waitingForSpot;
  return STATUS.error(err instanceof Error ? err.message : String(err));
}

test('main loop completes one session without error (simulate mode, cached data)', async () => {
  const config = makeTestConfig();
  const session = makeSimulateSession();
  const publisher = createPublisher(config);
  const clock = makeClock(SPEEDUP, FROM);

  await runMainLoop(session, publisher, config, FROM, errorStatus, clock);
  // Reaching here means the loop exited cleanly via justOnce.
  assert.ok(true);
  session.end();
});
