# evChargeBoss

## Workflow

- Every task ends with: `npx prettier --write <changed>` → `npm run build` → `git commit` (one per task; no batching unless asked)
- Run `npm test` before committing any change that touches planning logic

## Commands

```sh
node --experimental-strip-types src/index.ts --plan   # run from source (Node 22+)
npm run build                                          # → dist/bundle.cjs
npm test                                               # TZ=Europe/Helsinki CONFIG_FILE=test/fixtures/config.json
```

## TypeScript — Node 12 build target

Build target is Node 12. Banned APIs — use these alternatives instead:

| Banned                          | Use instead                                                                        |
| ------------------------------- | ---------------------------------------------------------------------------------- |
| `Array.prototype.findLast`      | `[...arr].reverse().find(...)`                                                     |
| `Array.prototype.at`            | index arithmetic                                                                   |
| `Intl` / locale date formatting | `localDateString()` / `localDateTimeString()` from `src/utils/date-time-format.ts` |
| native `fetch`                  | polyfilled via `node-fetch@2` in `src/utils/polyfill.ts`                           |

Other rules:

- Import file extensions must be `.ts`, not `.js`
- Type-only imports must use `import type`; no `tsconfig.json` in the repo
- Never `console.log` — use `makeLogger(category)` from `src/utils/log.ts`

## Date / time

All planning runs in **local time** (Europe/Helsinki). Cache file names and keys use `YYYY-MM-DD` / `YYYY-MM-DDTHH:MM:SS` — no Z suffix. Never call `.toLocaleDateString()` or `.toLocaleString()`.

## Error handling

- Main loop **never exits** on errors — catch, log, retry after 60 s
- Use `IncompleteDataError` (`src/electricity/IncompleteDataError.ts`) for missing-data conditions so callers can handle it separately
- `--plan` mode is the only mode that exits on error

## Testing

- Fixtures in `test/fixtures/` are **frozen** — never modify unless updating expected values alongside them
- **`CACHE_DIR` is captured at module-load time**: set `process.env.CACHE_DIR` _before_ any imports in test files
- Never add opt-in settings to `test/fixtures/config.json` — use `mqttOverrides` in `startMqttSession()` per-test
- MQTT integration tests: `docker compose up -d`; run sequentially (`concurrency: false`); close both clients with `client.end(true)` in `teardown()`
- New test files must be added to the `files` list in `package.json`
