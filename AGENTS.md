# Agent guide — evChargeBoss

Optimises home energy use (EV charging + heater setpoints) from spot prices and solar forecasts.

## Commands

```sh
node --experimental-strip-types src/index.ts --plan   # run from source (Node 22+)
npm run lint            # eslint, --max-warnings=0
npm run typecheck       # tsc --noEmit
npm run build           # tsc + esbuild -> dist/bundle.cjs (single file, Node 12 target)
npm run format          # prettier --write src/ test/
npm test                # unit tests (TZ pinned to Europe/Helsinki, concurrency 1)
npm run test:integration  # slow; needs docker compose up -d
```

Run a single test file:

```sh
TZ=Europe/Helsinki node --strip-types --test test/planner.test.ts
```

Before every commit: `npm run format` (or prettier on changed files), `npm run lint`,
`npm test`, `npm run build`. Run `npm run test:integration` too when touching
`src/ev-charging/coordinator.ts` or `state-machine.ts`.

## Committing

Commit after each completed task; do not batch tasks into one commit unless asked.

## Test gotchas

- `npm test` is _not_ fully offline: `test/mqtt-client.test.ts` needs a Mosquitto broker
  (`docker compose up -d`). Without it 2 tests fail with ECONNREFUSED — that is the
  environment, not your change.
- Integration tests need Mosquitto **and** InfluxDB (both in `docker-compose.yml`).
  Run one file at a time while iterating; they are slow (time is compressed via
  `config.test.timeSpeedupFactor`, set to 10000 in `test/helpers/config.ts`).
- Fixed scenario: start `2026-04-18T17:00:00` local (`FROM` in `test/helpers/config.ts`),
  planner fixture date `2026-04-18T10:00:00`.
- Cache fixtures live in `test/fixtures/.spot-cache-*.json` / `.solar-cache-*.json`.
  They are **matched by .gitignore and untracked** — a fresh clone has none, so tests will
  try to hit the network. Copy them over before assuming a failure is a regression.
  Never modify a fixture without updating the expected values in the same commit.
- Tests set `CACHE_DIR` / `CONFIG_FILE` via `process.env` at the **top of the file, before
  imports** — `CACHE_DIR` is read at module load in `spot.ts`/`solar.ts`/`poller.ts`, so a
  later assignment is too late.
- `test/fixtures/config.json` is shared by every test. Never add opt-in settings
  (e.g. `energyField`) to it; use `chargingOverrides` / `mqttOverrides` in
  `makeTestConfig()` / `startMqttSession()`.
- New test files must be added explicitly to the `test` or `test:integration` script in
  `package.json`.
- Use the helpers instead of hand-wiring: `startMqttSession()` (`test/helpers/mqtt-session.ts`)
  builds the full stack; `MqttRelaySimulator` (`test/helpers/mqtt-relay-simulator.ts`) fakes
  the relay (publishes power/energy while ON, records every command with timestamps).
- Each MQTT test uses two clients (`sessionClient`, `relayClient`); both must be closed
  with `client.end(true)` in teardown or the next test's socket bind fails.

## TypeScript conventions

- `tsconfig.json` is typecheck-only (`noEmit`, `erasableSyntaxOnly`, `strict`).
  Development runs unbuilt TS via node's type stripping — no emit step.
- Imports use `.ts` extensions; type-only imports must use `import type`
  (`erasableSyntaxOnly`: no enums, no parameter properties).
- **Build target is Node 12.** Do not use newer APIs without a polyfill:
  - `fetch` — polyfilled via `node-fetch@2` injected by esbuild (`src/utils/polyfill.ts`)
  - no `Array.prototype.findLast` — use `[...arr].reverse().find(...)`
  - no `Array.prototype.at` — use index arithmetic
  - no `Intl`-dependent formatting — use `localDateString()` / `localDateTimeString()`
    from `src/utils/date-time-format.ts`
- All `.ts` files live under `src/` or `test/`, never the repo root.
- Logging: use `makeLogger()` from `src/utils/log.ts`; ASCII only in log strings.

## Architecture

`src/index.ts` starts several independent loops in parallel, each gated on config presence:

- `runEvCharging` (always) — `src/ev-charging/`
- `runSetpointControl` per entry in `config.setpointControl` — `src/setpoint-control/`
  (water heater etc.; README still calls this "water heating")
- `runMqttToInflux` if `config.mqttToInflux`
- `runElectricityPoller` if `config.influx`

EV charging split:

- `state-machine.ts` — **pure and synchronous**: no await, no MQTT/network/timers.
- `coordinator.ts` — owns every side effect (relay sends, timer waits, MQTT status
  publishing, plan-file I/O via `src/utils/plan-store.ts`). `runSession()` lives here.
- `charger.ts` — `ChargingSession` wiring container (`driver`, `wattsSource?`, `holdSource?`)
  and `ChargerDriver.send(on)`.

State machine invariants:

- `WaitingForCar` keeps the relay ON (needed for plug-in detection).
- Any transition to `WaitingForCar` resets `plan`, `currentSlotStart`, `chargedKwh`,
  `detectedChargerPowerKw`.
- `SlotStart` event fields are applied by the coordinator before state logic runs.
- Car-finished detection compares watts to a configured threshold, never exact zero.
- `getStatusMessage()` must not flicker across consecutive charge slots: same run end ->
  identical `Charging until X` string.

`powerHoldFactor` (0–1): fraction of time the charger is expected free (not paused for
space heating), computed by `HeatingTracker` (`src/ev-charging/heating-tracker.ts`) from a
rolling 1-minute sample buffer. Defaults to 1.0. The state machine multiplies
`detectedChargerPowerKw * powerHoldFactor` before `computePlan()`. See
`docs/heating-hold-algorithm.md`.

## Config

`Config` (`src/config.ts`) is zod-validated JSON, resolved in order:
`CONFIG_FILE` env -> `--config <path>` -> `./config.json` -> `config-example.json`
(fallback with a loud warning). `config.json` is gitignored.

## Time and caching

- All planning is in local time (Europe/Helsinki in production). Cache files are named
  `YYYY-MM-DD` and keyed `YYYY-MM-DDTHH:MM:SS`, local time, **no `Z` suffix**.
- Spot/solar data cached per day to `.spot-cache-*.json` / `.solar-cache-*.json` in
  `CACHE_DIR` (default `.`). Cache is written only **after** validation passes.
  Do not clear caches lightly — forecast.solar's free tier rate-limits hard
  (Open-Meteo is the automatic fallback).

## Error handling

The main charge/simulate loops never exit on error: catch, log, retry after 60 s.
Use `IncompleteDataError` (`src/electricity/IncompleteDataError.ts`) for missing data so
callers can distinguish it. `--plan` mode is the only mode that exits on error.
