# Next steps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.

- [x] Still some unwanted status transitions on MQTT. Log below. When charging was finished, it seems that at next slot it went to "waiting" while I think it should remain in finished until something actually changes.

```
12:00:00 - 8 hours ago changed to Idle

11:30:00 - 8 hours ago changed to Waiting for charging to start

11:24:09 - 8 hours ago changed to Charging finished

10:15:25 - 10 hours ago changed to Charging until 12:00
```