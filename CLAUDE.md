# Agent guide — evChargeBoss

## Workflow

- Every task: `npx prettier --write <changed>` → `npm run build` → `git commit` (one per task; no batching unless asked)
- Touch planning logic? Run `npm test` before committing.

## Commands

```sh
node --experimental-strip-types src/index.ts --plan   # run from source (Node 22+)
npm run build                                          # → dist/bundle.cjs
npm test                                               # TZ=Europe/Helsinki CONFIG_FILE=test/fixtures/config.json
```

## Project layout

```
src/          TypeScript sources
test/         tests
  fixtures/   frozen — never modify unless updating expected values alongside them
  helpers/    mqtt-session.ts, mqtt-relay-simulator.ts, config.ts
```

New test files must be added to the `files` list in `package.json`.

## TypeScript — Node 12 build target

- Runtime: `node --experimental-strip-types`. No `tsconfig.json`. Imports: `.ts` extensions; `import type` for type-only.
- Never `console.log` — use `makeLogger(category)` from `src/utils/log.ts`.
- Banned (not in Node 12):
  - `Array.prototype.findLast` → `[...arr].reverse().find(...)`
  - `Array.prototype.at` → index arithmetic
  - `Intl` / locale date formatting → `localDateString()` / `localDateTimeString()` from `src/utils/date-time-format.ts`
  - native `fetch` → polyfilled in `src/utils/polyfill.ts`

## Date / time

All planning in **local time** (Europe/Helsinki). Cache keys: `YYYY-MM-DDTHH:MM:SS` (no Z). Use `localDateString()` / `localDateTimeString()` — never `.toLocaleDateString()`.

## Caching

`.spot-cache-YYYY-MM-DD.json` / `.solar-cache-YYYY-MM-DD.json` in `CACHE_DIR` (default `.`). Write only after validation passes. Don't clear — forecast.solar rate-limits aggressively.

## Key abstractions

- **`ChargingSession`** (`src/ev-charging/charger.ts`): `waitForStart()` + `driver`. New charge modes implement this; `src/index.ts` unchanged.
- **`ChargerDriver`**: `send(on: boolean)`. MQTT mode uses `makeMqttSession()`.
- **`Config`** (`src/config.ts`): `CONFIG_FILE` env → `--config` flag → `config.json` → `config-example.json`.
- **`Slot`** (`src/ev-charging/types.ts`): unit of EV planning; cost fields in euros; `solarForecastW` in watts.

## Error handling

- Main loop never exits — catch, log, retry after 60 s.
- Use `IncompleteDataError` (`src/electricity/IncompleteDataError.ts`) for missing data.
- `--plan` mode is the only mode that exits on error.

## Testing

- Fixed start date: `2026-04-18T10:00:00` Helsinki. Fixtures are frozen; tests never hit the network.
- **`CACHE_DIR` is captured at module-load time** — set `process.env.CACHE_DIR` before imports (top of test file).
- Never add opt-in settings to `test/fixtures/config.json`; use `mqttOverrides` in `startMqttSession()`.
- MQTT tests: `docker compose up -d`; run sequentially (`concurrency: false`); close both clients with `client.end(true)` in `teardown()`.

## Solar forecast sources

1. **forecast.solar** — primary; tilt/azimuth-aware; returns system AC output (kW).
2. **Open-Meteo** — fallback on non-2xx; GHI-based: `(GHI_W_m2 / 1000) * kwp * 1000`.
