# Next steps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.


- [x] It now seems that when charging we get a "charging finished" -> "charging started" at each slot transition. Not good! I think there's still something wrong with the logic. Investigate, fix, see if tests can be improved. Log below.

```
[2026-04-28T20:39:42] [Status] Planned charge start at 9:00
[2026-04-28T20:39:42] [MQTT] <E2><86><92> OFF published to zigbee2mqtt/Auton laturi/set
[2026-04-28T20:39:42] Charging starts at 9:00 (in 44418s)
[2026-04-29T09:00:00] [ON ] 9:00<E2><80><93>9:15 | solar-free
[2026-04-29T09:00:00] [Status] Waiting for charging to start
[2026-04-29T09:00:00] [MQTT] <E2><86><92> ON  published to zigbee2mqtt/Auton laturi/set
[2026-04-29T09:00:25] [Status] Charging until 11:30 | 0.00 kWh charged, 7.50 kWh remaining
[2026-04-29T09:15:00] [Status] Charging finished | 0.75 kWh charged, <E2><82><AC>0.000 total cost, 100% solar
[2026-04-29T09:15:00]   Spot prices loaded from cache (96 slots)
[2026-04-29T09:15:00]   Solar forecast loaded from cache (18 slots)
[2026-04-29T09:15:00]   Spot prices cached (1 day file(s)).
[2026-04-29T09:15:00]   9 solar slots without exact match <E2><80><94> using nearest preceding value
[2026-04-29T09:15:00]   Solar forecast cached (1 day file(s)).
[2026-04-29T09:15:00] Planning 11 slots from 9:15 to 2026-04-29T12:00:00
[2026-04-29T09:15:00] Need 9 slots to deliver 6.75 kWh at 3 kW
[2026-04-29T09:15:00] Plan changed:
[2026-04-29T09:15:00]   TIME   SPOT         SOLAR        COST
[2026-04-29T09:15:00]   -----  -----------  ------  ---------
[2026-04-29T09:15:00]   09:15  14.27 c/kWh  *3259W       FREE  CHARGE
[2026-04-29T09:15:00]   09:30  13.34 c/kWh  *3259W       FREE  CHARGE
[2026-04-29T09:15:00]   09:45  11.74 c/kWh  *3259W       FREE  CHARGE
[2026-04-29T09:15:00]   10:00  12.95 c/kWh  *4485W       FREE  CHARGE
[2026-04-29T09:15:00]   10:15  11.77 c/kWh  *4485W       FREE  CHARGE
[2026-04-29T09:15:00]   10:30   6.29 c/kWh  *4485W       FREE  CHARGE
[2026-04-29T09:15:00]   10:45   4.39 c/kWh  *4485W       FREE  CHARGE
[2026-04-29T09:15:00]   11:00   4.60 c/kWh  *5282W       FREE  CHARGE
[2026-04-29T09:15:00]   11:15   4.19 c/kWh  *5282W       FREE  CHARGE
[2026-04-29T09:15:00]   11:30   4.11 c/kWh  *5282W       FREE
[2026-04-29T09:15:00]   11:45   3.86 c/kWh  *5282W       FREE
[2026-04-29T09:15:00] --- Total: 9 slots, ~0.000 EUR charging cost, 9 solar-free slots
[2026-04-29T09:15:00] [Plan] Target: 7.50 kWh | Charged so far: 0.75 kWh | Remaining: 6.75 kWh
[2026-04-29T09:15:00] [ON ] 9:15<E2><80><93>9:30 | solar-free
[2026-04-29T09:15:00] [MQTT] <E2><86><92> ON  published to zigbee2mqtt/Auton laturi/set
[2026-04-29T09:30:00] [Status] Charging finished | 1.50 kWh charged, <E2><82><AC>0.000 total cost, 100% solar
[2026-04-29T09:30:00]   Spot prices loaded from cache (96 slots)
[2026-04-29T09:30:00]   Solar forecast loaded from cache (18 slots)
[2026-04-29T09:30:00]   Spot prices cached (1 day file(s)).
[2026-04-29T09:30:00]   8 solar slots without exact match <E2><80><94> using nearest preceding value
[2026-04-29T09:30:00]   Solar forecast cached (1 day file(s)).
[2026-04-29T09:30:00] Planning 10 slots from 9:30 to 2026-04-29T12:00:00
```

- [x] Another thing from log: also the plan is printed each time, even though nothing changes. You should check if any slot-decision is changed. If there are no changed decisions, there's no need to print the plan update. Now, if charging continues between slots without change in plan, the log should look simply like this:

```
[2026-04-29T09:00:25] [Status] Charging until 11:30 | 0.00 kWh charged, 7.50 kWh remaining
[2026-04-29T09:15:25] [Status] Charging until 11:30 | 0.75 kWh charged... etc
```

Until it's finished. Make sure not to log any activity related to re-planning except changed decisions.


- [x] If there are more solar free slots after goal is estimated to be reached, mark these slots also as charging slots. Just in case, to utilize all solar energy if there's room in the car battery.