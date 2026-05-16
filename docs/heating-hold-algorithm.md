# Heating Hold Algorithm and Statistics

## Background

When a heat pump or electric heating system is running, it can draw several kilowatts of power simultaneously with EV charging. To avoid overloading the household circuit, the EV charger pauses ("holds") whenever heating demand is detected above a configurable `thresholdW`.

This document describes how the system learns the heating behavior from real power measurements and derives parameters used later in charge planning.

## Configuration (`holdWhenHeating`)

| Field | Default | Description |
|-------|---------|-------------|
| `thresholdW` | — | Watts above which heating is considered active (triggers hold) |
| `maxHoldPercentage` | 20 | Maximum acceptable % of time heating power exceeds `holdPowerLevel` |
| `holdMargin` | 100 | Watts added to `holdPowerLevel` to form `powerHoldThreshold` (safety margin) |
| `statisticsPeriodHours` | 24 | Rolling buffer length in hours |

## 1-Minute Sample Buffer

Every time a heating power reading arrives from MQTT, the system records it as the latest known value. Once per minute (on the minute boundary), the latest known value is pushed into a rolling buffer. The buffer holds `statisticsPeriodHours × 60` samples (e.g. 1440 samples for 24 h).

Gap-filling: if no MQTT message arrives during a minute, the last known value is used — this is the most conservative assumption (heating stayed at the same level).

No samples are recorded until at least one MQTT reading has been received.

## Statistics Computation

Statistics are computed and logged every 15 minutes, but only once the rolling buffer is fully populated (i.e. after `statisticsPeriodHours` have elapsed since the first reading).

### Step 1 — Sort the buffer

```
sorted = buffer.sort(ascending)
n = len(sorted)
```

### Step 2 — holdPowerLevel

```
percentileIndex = floor((1 - maxHoldPercentage / 100) × n)
holdPowerLevel  = sorted[percentileIndex]
```

`holdPowerLevel` is the **(100 − maxHoldPercentage)th percentile** of power samples. Only `maxHoldPercentage`% of samples exceed this value. With the default `maxHoldPercentage = 20`, this is the 80th percentile: only 20% of samples are above it.

Intuitively: if `holdPowerLevel` were used as the hold trigger, the charger would be held at most `maxHoldPercentage`% of the time (based on historical distribution).

### Step 3 — powerHoldThreshold

```
powerHoldThreshold = holdPowerLevel + holdMargin
```

`holdMargin` (default 100 W) adds a safety buffer so that minor fluctuations above `holdPowerLevel` still allow charging.

### Step 4 — powerHoldFactor

```
powerHoldFactor = count(s < powerHoldThreshold) / n
```

The fraction of samples (0–1) that fall strictly below `powerHoldThreshold`. This represents the expected proportion of time the charger can run without being held, given the observed heating behavior and the threshold.

### Step 5 — heatingOnPercentage

```
heatingOnPercentage = count(s >= thresholdW) / n × 100
```

The percentage of time heating power was at or above the configured `thresholdW`. This is the historical hold rate based on the existing threshold — a useful sanity check alongside the new statistics.

## Future Use in Plan Calculations

`powerHoldFactor` will be used to adjust the required charging time in the planner:

```
adjustedChargingTime = naiveChargingTime / powerHoldFactor
```

For example, if `powerHoldFactor = 0.75` (charger is free 75% of the time), the planner allocates 33% more slots than a naive calculation to account for expected hold interruptions. This produces more realistic plans and avoids falling short of the target kWh due to heating pauses.

## Logging

Statistics are logged every 15 minutes (once the buffer is full) to the `ev-charging-heating-stats` log category:

```
[ev-charging-heating-stats] holdPowerLevel=2800W threshold=2900W holdFactor=0.823 heatingOn=31.4% samples=1440 period=2026-05-15T12:00:00 -> 2026-05-16T12:00:00
```

Statistics are also persisted to `.stats/heating-statistics.json` so they survive restarts.
