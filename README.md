# evChargeBoss

Optimises home energy use by combining day-ahead spot electricity prices with solar production forecasts.

- **EV charging** — selects the cheapest 15-minute slots within a daily window, treating solar-covered slots as effectively free.
- **Water heater** (optional) — adjusts the temperature setpoint every 15 minutes: `targetTemperatureCheap` during cheap/solar slots, `targetTemperatureDefault` otherwise. "Cheap" means the slot price is below half the 24-hour average (configurable).

Designed for Finnish electricity markets (spot-hinta.fi) and home solar + MQTT-controlled hardware.

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

## Development container

`.devcontainer/` provides a ready-made environment (Node 24, Mosquitto, InfluxDB, opencode,
GitHub CLI). Open the repo in VS Code and choose **Reopen in Container**, or:

```sh
devcontainer up --workspace-folder .
```

Mosquitto and InfluxDB share the app container's network namespace, so they are reachable
on `localhost:1883` / `localhost:8086` inside the container — the same addresses the tests
and `config-example.json` use. Both are also published to the host, so stop the top-level
`docker compose` stack first if it is running; the ports collide.

The root `docker-compose.yml` is unchanged, so the plain host workflow (`docker compose up -d`
plus a local Node) still works.

Notes:

- `node_modules` lives in a named volume, not the bind mount, so Linux binaries (esbuild)
  never overwrite the host's. `npm ci` runs automatically on create.
- opencode's config is bind-mounted from `.devcontainer/opencode` (gitignored, container-local);
  its auth and session state live in a named volume, so you log in once and rebuilds keep it.
  Set `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GH_TOKEN` on the host and they are forwarded in.
- `~/.gitconfig` and `~/.ssh` are mounted from the host (ssh read-only).
- `npm test`, `npm run lint` and `npm run build` pass in the container.
  `test/main-loop-mqtt.test.ts` does **not**: its 10000× time compression leaves ~30 ms of
  real time per virtual 5-minute window, which the container's extra latency overruns. Run
  that file on the host for now.

## Modes

| Flag     | Behaviour                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| _(none)_ | **Charge mode** — connects to MQTT, waits for car plug-in detection (power > threshold), plans, then controls the relay. Loops forever. |
| `--plan` | Fetch data, print the plan, exit. No charging.                                                                                          |

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

### Water heating (optional)

When present, the program also controls a water heater via a single MQTT setpoint topic, running in parallel with EV charging.

```jsonc
"waterHeating": {
  "targetTemperatureDefault": 45,  // °C during expensive slots
  "targetTemperatureCheap": 65,    // °C during cheap or solar-free slots
  "cheapFactor": 0.5,                    // slot is "cheap" if price < dailyAvg × cheapFactor
  "solarWattsThresholdForCheap": 2000,   // min solar forecast (W) to treat a slot as free
  "mqtt": {
    "commandTopic": "zigbee2mqtt/water-heater/set"  // raw numeric string published here
  }
}
```

The payload is a plain number string (e.g. `"65"`). Find the correct topic with an MQTT explorer tool.

## Data sources

| Source                                   | Used for                       | Notes                                            |
| ---------------------------------------- | ------------------------------ | ------------------------------------------------ |
| [spot-hinta.fi](https://spot-hinta.fi)   | Day-ahead spot prices (15-min) | Finland, no key required                         |
| [forecast.solar](https://forecast.solar) | Solar production forecast      | Tilt/azimuth-aware, free tier                    |
| [Open-Meteo](https://open-meteo.com)     | Solar fallback                 | Used automatically if forecast.solar rate-limits |

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
  index.ts                  entry point — starts EV charging + water heating loops
  config.ts                 root Config type, JSON loader
  ev-charging/
    planner.ts              EV slot selection logic
    main-loop.ts            charging session state machine
    charger.ts              ChargingSession / ChargerDriver interfaces
    mqtt-client.ts          MQTT connect, plug-in detection, makeMqttSession()
    mqtt-status.ts          status publisher
    config.ts               EvChargingConfig type
    types.ts                Slot interface
  water-heating/
    planner.ts              assigns targetTemp per 15-min slot over 24h
    index.ts                runWaterHeating() loop + runWaterHeatingLoop() (testable)
    config.ts               WaterHeatingConfig type
    types.ts                WaterHeatingSlot interface
  electricity/
    index.ts                fetchSlots() — spot prices + solar forecast
    spot.ts                 spot price fetching + per-day file cache
    solar.ts                solar forecast fetching + per-day file cache
    solar-openmeteo.ts      Open-Meteo backup solar source
    cache.ts                readCache / writeCache helpers
    types.ts                PricedSlot interface
  utils/
    log.ts                  timestamped logger
    timing-utils.ts         Clock, Canceller, sleep
    date-time-format.ts     locale-independent date formatters
    polyfill.ts             fetch polyfill injected by esbuild for Node < 18
config-example.json         template configuration
test/
  planner.test.ts           unit tests for EV plan()
  water-heating-test.ts     unit + loop tests for water heating
  fixtures/                 frozen cache files + config used by tests
```
