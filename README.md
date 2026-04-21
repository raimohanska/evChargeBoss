# evChargeBoss

Plans EV charging slots to minimise cost by combining day-ahead spot electricity prices with solar production forecasts. Selects the cheapest 15-minute slots within a configurable window, treating solar-covered slots as effectively free.

Designed for Finnish electricity markets (spot-hinta.fi) and home solar + MQTT-controlled relay hardware.

## Requirements

- **Development / direct run**: Node.js v22+ (`--experimental-strip-types` runs TypeScript without a build step)
- **Deployed bundle**: Node.js 12+ (`dist/bundle.cjs` is a self-contained CommonJS build)

```sh
nvm use   # picks up .nvmrc → lts/*
```

## Quick start

```sh
cp config-example.json config.json
# edit config.json for your location, solar system, and MQTT broker
npm run build
node dist/bundle.cjs
```

Or run directly from source (Node 22+):

```sh
node --experimental-strip-types src/index.ts
```

## Modes

| Flag | Behaviour |
|------|-----------|
| *(none)* | **Charge mode** — connects to MQTT, waits for car plug-in detection (power > threshold), plans, then controls the relay. Loops forever. |
| `--plan` | Fetch data, print the plan, exit. No charging. |

All modes accept:

- `--from <ISO datetime>` — start planning from a past date (e.g. `--from 2026-04-18T10:00:00`). Useful for replaying historical data. Only affects the first iteration.
- `--config <path>` — path to config file (default: `config.json`, fallback: `config-example.json` with a warning)

## Configuration

Copy `config-example.json` to `config.json` and edit it. `config.json` is gitignored.

### MQTT

```jsonc
"mqtt": {
  "brokerUrl": "mqtt://homeassistant.local:1883",
  "username": "",           // leave empty if no auth
  "password": "",
  "powerTopic": "zigbee2mqtt/ev-relay",   // subscribe for power readings
  "powerField": "power",                  // JSON key containing watts
  "powerThresholdW": 10,                  // watts above which car is considered plugged in
  "chargerTopic": "zigbee2mqtt/ev-relay/set",
  "onPayload":  "{\"state\":\"ON\"}",
  "offPayload": "{\"state\":\"OFF\"}"
}
```

The intended hardware target is a **NOUS D3Z** DIN-rail relay (25 A, Zigbee) via Zigbee2MQTT, but any relay that publishes a power field and accepts a JSON set-topic will work.

### Charging

```jsonc
"charging": {
  "targetKwh": 7,       // energy needed per session
  "powerKw": 3,         // charger power
  "targetTime": "12:00" // next-day deadline (local time)
}
```

### Solar

```jsonc
"solar": {
  "lat": 61.5, "lon": 24.7,
  "declination": 35,      // roof pitch in degrees (0 = flat, 90 = vertical)
  "azimuth": 0,           // 0 = south, -90 = east, 90 = west
  "kwp": 7.5,             // installed DC peak power
  "treeShadingSchedule": [   // optional: waypoints for local shading
    { "time": "13:00", "outputFraction": 1.0 },
    { "time": "14:30", "outputFraction": 0.5 },
    { "time": "16:30", "outputFraction": 0.1 }
  ]
}
```

`treeShadingSchedule` maps local times to remaining output fraction. Values are linearly interpolated. Before the first entry: no shading (1.0). After the last: last fraction held constant.

### Electricity

```jsonc
"electricity": {
  "transportCostEurKwh": 0.045  // transfer tariff + taxes (€/kWh)
}
```

## Data sources

| Source | Used for | Notes |
|--------|----------|-------|
| [spot-hinta.fi](https://spot-hinta.fi) | Day-ahead spot prices (15-min) | Finland, no key required |
| [forecast.solar](https://forecast.solar) | Solar production forecast | Tilt/azimuth-aware, free tier |
| [Open-Meteo](https://open-meteo.com) | Solar fallback | Used automatically if forecast.solar rate-limits |

Both price and solar data are cached to disk as per-day JSON files (`.spot-cache-YYYY-MM-DD.json`, `.solar-cache-YYYY-MM-DD.json`). The cache accumulates across days, enabling historical replay with `--from`.

## Building

```sh
npm run build      # produces dist/bundle.cjs (Node 12+, single file, no node_modules needed)
```

The bundle includes all dependencies and a `fetch` polyfill for Node < 18.

## Testing

```sh
npm test
```

Tests use fixed cache fixtures in `test/fixtures/` and a pinned start date so they never hit the network and always produce the same plan.

## Project layout

```
src/
  index.ts          entry point, CLI flag parsing, main loop
  config.ts         Config type definition, JSON loader
  types.ts          Slot interface
  planner.ts        core planning logic (slot selection)
  printer.ts        terminal plan output (ANSI colours)
  charger.ts        ChargingSession / ChargerDriver interfaces, runCharging loop
  mqtt-client.ts    MQTT connect, plug-in detection, makeMqttSession()
  spot.ts           spot price fetching + per-day file cache
  solar.ts          solar forecast fetching + per-day file cache
  solar-openmeteo.ts  Open-Meteo backup solar source
  cache.ts          readCache / writeCache helpers
  errors.ts         IncompleteDataError
  utils.ts          log, sleep, assertNotNull, localDateString, localDateTimeString
  polyfill.ts       fetch polyfill injected by esbuild for Node < 18
config-example.json template configuration
test/
  planner.test.ts   unit tests for plan()
  fixtures/         frozen cache files + config used by tests
```
