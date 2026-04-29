# Next steps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.

- [x] See if it's possible to get the actual charging power of the charger by running it ON for 15 seconds when power is detected. This should allow us to remove the configuration setting for power.
- [ ] Use maximum instead of average when determining the charge power
- [ ] MQTT status messages are now missing after clean-up. Log below. You see that the relay was turned OFF, but status not updated. Update tests so that this would fail and then fix properly. See if a refactoring is possible to ensure that status updates and relay control are always in sync.

```
[2026-04-29T20:40:35] [Status] Charging until 22:45 | 0.00 kWh charged, 7.50 kWh remaining
[2026-04-29T20:40:59] [MQTT] Target time updated to 12:00
[2026-04-29T20:40:59] [MQTT] -> OFF published to zigbee2mqtt/Auton laturi/set
[2026-04-29T20:40:59] Target time changed <E2><80><94> re-planning with 7.50 kWh remaining.
[2026-04-29T20:41:00] Plan changed:
[2026-04-29T20:41:00]   TIME   SPOT         SOLAR        COST
[2026-04-29T20:41:00]   -----  -----------  ------  ---------
[2026-04-29T20:41:00]   20:30  11.36 c/kWh  *  21W  0.118 EUR
[2026-04-29T20:41:00]   20:45  13.78 c/kWh  *  21W  0.136 EUR
[2026-04-29T20:41:00]   21:00  15.96 c/kWh  *   6W  0.153 EUR
[2026-04-29T20:41:00]   21:15  16.22 c/kWh      0W  0.155 EUR
[2026-04-29T20:41:00]   21:30  16.35 c/kWh      0W  0.156 EUR
[2026-04-29T20:41:00]   21:45  15.67 c/kWh      0W  0.151 EUR
```