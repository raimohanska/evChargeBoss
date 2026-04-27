# Next steps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.

Here's a sample piece of log

```
[2026-04-27T08:30:00.026Z] [Status] Planned charge start at 11:30
[2026-04-27T08:30:00.026Z] [ON ] 11:30<E2><80><93>11:45 | solar-free
[2026-04-27T08:30:00.026Z] [Status] Waiting for charging to start
[2026-04-27T08:30:00.027Z] [MQTT] <E2><86><92> ON  published to zigbee2mqtt/Auton laturi/set
[2026-04-27T08:30:00.075Z] [Status] Charging until 12:00
[2026-04-27T08:30:51.965Z] [Status] Charging until 12:00
[2026-04-27T08:31:52.065Z] [Status] Charging until 12:00
[2026-04-27T08:31:53.086Z] [Status] Charging until 12:00
[2026-04-27T08:32:32.039Z] [Status] Charging until 12:00
[2026-04-27T08:32:37.031Z] [Status] Charging until 12:00
[2026-04-27T08:32:42.024Z] [Status] Charging until 12:00
[2026-04-27T08:32:47.016Z] [Status] Charging until 12:00
[2026-04-27T08:32:52.058Z] [Status] Charging until 12:00
[2026-04-27T08:32:52.086Z] [Status] Charging until 12:00
[2026-04-27T08:32:57.001Z] [Status] Charging until 12:00
[2026-04-27T08:33:01.995Z] [Status] Charging until 12:00
[2026-04-27T08:33:06.987Z] [Status] Charging until 12:00
[2026-04-27T08:33:11.977Z] [Status] Charging until 12:00
[2026-04-27T08:33:16.970Z] [Status] Charging until 12:00
[2026-04-27T08:33:21.962Z] [Status] Charging until 12:00
[2026-04-27T08:33:26.956Z] [Status] Charging until 12:00
[2026-04-27T08:33:31.948Z] [Status] Charging until 12:00
[2026-04-27T08:33:39.420Z] [Status] Charging until 12:00
[2026-04-27T08:33:44.413Z] [Status] Charging until 12:00
[2026-04-27T08:33:49.441Z] [Status] Charging until 12:00
[2026-04-27T08:33:52.170Z] [Status] Charging until 12:00
[2026-04-27T08:34:01.451Z] [Status] Charging until 12:00
[2026-04-27T08:34:06.447Z] [Status] Charging until 12:00
[2026-04-27T08:34:31.452Z] [Status] Charging finished
[2026-04-27T08:34:36.439Z] [Status] Charging finished
[2026-04-27T08:34:52.251Z] [Status] Charging finished
```

- [x] Make sure the log timestamp is local (Helsinki) not UTC
- [x] Get rid of the repeated "Charging until" messages. Not sure why so many are printed out in a single slot. I think just a single one would suffice.
- [x] In these per-slot status log messages, include also "x kWh charged, y kWh remaining"
- [x] Also don't repeat the finished message. In that, include total charged amount so far, as well as total accumulated cost (based on the price calculations in the plan). You may have to track the accumulated cost in the state
- [ ] In the charging finished message, also include the accumulated solar percentage. We're preparing to push these values to a database later. Just logging for now though.
