# Agent guide — evChargeBoss

## Always commit after changes

Every completed task ends with a `git commit`. Do not batch multiple tasks into one commit unless the user explicitly asks. The user expects a commit after each change.

Run `npx prettier --write` on changed files before committing.

Run `npm run build` before committing. Fix any TypeScript or build errors before the commit goes in.

## Running the code

```sh
node --experimental-strip-types src/index.ts --plan   # run from source (Node 22+)
npm run build                                          # produce dist/bundle.cjs
npm test                                               # run unit tests
```

Tests use `TZ=Europe/Helsinki` and `CONFIG_FILE=test/fixtures/config.json`. Always run tests before committing a change that touches planning logic.

Test files are listed explicitly in `package.json` — add new test files there.

## Project layout

All TypeScript source lives under `src/`. Tests live under `test/`. Do not put `.ts` files in the project root.

```
src/          TypeScript sources
test/         tests + fixtures
  helpers/    shared test helpers (mqtt-session.ts, mqtt-relay-simulator.ts, config.ts)
  fixtures/   frozen cache files and config — never modify these unless updating expected test values
config-example.json   committed template; users copy this to config.json
config.json   gitignored user config (may not exist in checkout)
```

## TypeScript conventions

- Runtime: `node --experimental-strip-types` — no build step for development.
- No `tsconfig.json`. Type-only imports must use `import type`.
- File extensions in imports must be `.ts`, not `.js`.
- The build target is Node 12 (via esbuild). Do not use APIs introduced after Node 12 without a polyfill:
  - `fetch` — polyfilled via `node-fetch@2` injected by esbuild (`src/utils/polyfill.ts`)
  - `Array.prototype.findLast` — not available; use `[...arr].reverse().find(...)`
  - `Array.prototype.at` — not available; use index arithmetic
- Do not rely on `Intl` / locale-dependent date formatting — Node 12 ships with limited ICU data. Use `localDateString()` and `localDateTimeString()` from `src/utils.ts` instead of `toLocaleDateString` / `toLocaleString`.

## Key abstractions

**`ChargingSession`** (`src/ev-charging/charger.ts`) — runtime wiring container:

- `driver: ChargerDriver` — sends ON/OFF commands
- `wattsSource?: WattsSource` — emits power/energy telemetry
- `holdSource?: HoldSource` — emits heating-hold state

Startup detection and event orchestration are handled by `runSession()` in `src/ev-charging/coordinator.ts`.

**`ChargerDriver`** (`src/ev-charging/charger.ts`) — single method `send(on: boolean)`. MQTT mode uses `makeMqttSession()` from `src/ev-charging/mqtt-client.ts`.

**`Config`** (`src/config.ts`) — loaded from JSON at startup. Resolution order:

1. `CONFIG_FILE` env var
2. `--config <path>` argv flag
3. `config.json` in CWD (if it exists)
4. `config-example.json` (fallback, prints a loud warning)

**`Slot`** (`src/types.ts`) — the unit of planning. All cost fields are in euros; `solarForecastW` is watts.

## State machine invariants

- `src/ev-charging/state-machine.ts` is pure and synchronous: no awaiting, no MQTT/network/timer side effects.
- Coordinator owns all effects (relay sends, timer waits, MQTT status publishing, plan-file I/O).
- `WaitingForCar` must keep relay ON for plug-in detection.
- Any transition to `WaitingForCar` must reset session fields (`plan`, `currentSlotStart`, `chargedKwh`, `detectedChargerPowerKw`).
- `SlotStart` is applied by coordinator-level event field handling before state logic.
- Car-finished detection compares watts against configured threshold, never exact zero.
- `SleepingUntilSlot` ignores `ForecastAvailable`; planning reacts to forecast updates.
- `getStatus()` must avoid flicker for consecutive charge slots: same run end -> same `Charging until X` string.

## Date / time rules

All planning is in **local time** (Europe/Helsinki in production). Cache files are named `YYYY-MM-DD` and keyed `YYYY-MM-DDTHH:MM:SS` — both in local time, no Z suffix. Use `localDateString(d)` and `localDateTimeString(d)` from `src/utils.ts` everywhere dates become strings.

## Caching

Spot price and solar data are cached per-day to `.spot-cache-YYYY-MM-DD.json` / `.solar-cache-YYYY-MM-DD.json` in the directory given by `CACHE_DIR` env var (default: `.`). Cache is written **after** data validation passes, never before. Do not clear caches lightly — the forecast.solar free tier rate-limits aggressively.

## Error handling

The main charge/simulate loop **never exits** on errors. All exceptions are caught, logged, and retried after 60 s. Use `IncompleteDataError` (`src/errors.ts`) for missing data so callers can handle it distinctly from unexpected errors. `--plan` mode is the only mode that exits on error.

## Testing conventions

- Tests in `test/planner.test.ts` use Node's built-in `node:test` runner.
- Fixed start date: `2026-04-18T10:00:00` (local Helsinki time).
- Cache fixtures in `test/fixtures/` — frozen, never touched by tests.
- Config fixture in `test/fixtures/config.json` — frozen copy of `config-example.json`.
- Tests never hit the network. If a change would require new fixture data, update the fixtures and the expected values together.
- `CACHE_DIR` env var points tests at `test/fixtures/` so they never read or write the working cache.

## MQTT integration test conventions

- MQTT integration tests require a Mosquitto broker: `docker compose up -d`.
- Tests run sequentially (`concurrency: false`) — concurrent MQTT sessions on the same topics would interfere.
- `MqttRelaySimulator` (`test/helpers/mqtt-relay-simulator.ts`) simulates the physical relay: subscribes to the charger command topic, publishes power/energy readings on the power topic when ON, and tracks every relay command with timestamps.
- `startMqttSession()` (`test/helpers/mqtt-session.ts`) wires up the full stack. It accepts `chargingOverrides` and `mqttOverrides` to customise a test without touching the shared fixture config.
- **Never add `energyField` (or other opt-in settings) to `test/fixtures/config.json`** — that fixture is shared by all integration tests. Use `mqttOverrides` in `startMqttSession()` to enable them per-test.
- The `CACHE_DIR` constant in `spot.ts` / `solar.ts` is captured at module-load time (ES module top-level). Setting `process.env.CACHE_DIR` in the test file body **after** imports is too late. Tests that need the env var must set it before any imports (use `process.env` assignment at the top of the file, before imports).
- Each MQTT test session uses two clients: `sessionClient` (drives the main loop) and `relayClient` (simulates the relay). Both must be closed in `teardown()` with `client.end(true)` (force-close) so TCP sockets are freed before the next test.

## Build

```sh
npm run build
```

Output is `dist/bundle.cjs` — single file, all deps inlined, no `node_modules` needed at runtime.


## Skills

Use skills from .claude/skills
