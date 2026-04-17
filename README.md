# evChargeBoss

Plans EV charging slots to minimise cost by combining day-ahead spot electricity prices with solar production forecasts. Selects the cheapest 15-minute slots within a configurable time window, treating solar-heavy slots as free.

## Requirements

Node.js v22+ (uses `--experimental-strip-types` to run TypeScript directly — no build step needed).

```sh
nvm use  # uses .nvmrc → lts/*
```

## Running

```sh
node index.ts
```

The planner fetches spot prices and solar forecast, prints the charging plan, then exits.

## Configuration

Edit `config.ts`:

| Key | Default | Description |
|-----|---------|-------------|
| `charging.targetKwh` | `7` | Energy needed per session (kWh) |
| `charging.powerKw` | `3` | Charger power (kW) |
| `charging.targetTime` | `"12:00"` | Next-day deadline (local time) |
| `solar.lat` / `lon` | `61.5` / `24.7` | Location |
| `solar.declination` | `35` | Roof pitch (degrees) |
| `solar.azimuth` | `0` | Roof azimuth (0=south, −90=east, 90=west) |
| `solar.kwp` | `7.5` | Installed peak capacity (kWp) |
| `solar.efficiencyFactor` | `0.85` | System efficiency (inverter losses etc.) |
| `solar.freeThresholdW` | `400` | Solar output above which a slot is considered free |
| `electricity.transportCostEurKwh` | `0.045` | Transfer tariff + taxes (€/kWh) |

## Data sources

- **Spot prices** — [spot-hinta.fi](https://spot-hinta.fi) (Finnish day-ahead prices, 15-min slots, no key required)
- **Solar forecast** — [forecast.solar](https://forecast.solar) (tilt/azimuth-aware, free tier), with automatic fallback to [Open-Meteo](https://open-meteo.com) if rate-limited

Both sources are cached to disk for the current day so repeated runs are instant and don't hit rate limits.

## File structure

```
index.ts          entry point + program plan
config.ts         CONFIG object and Slot type
planner.ts        slot planning and plan printer
spot.ts           spot price fetching (spot-hinta.fi)
solar.ts          solar forecast fetching (forecast.solar) with fallback
solar-openmeteo.ts  backup solar forecast (Open-Meteo)
cache.ts          day-scoped file cache
utils.ts          log, sleep, assertNotNull
```
