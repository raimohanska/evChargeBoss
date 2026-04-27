# Next steps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.

- [x] Make sure the log timestamp is local (Helsinki) not UTC
- [x] Get rid of the repeated "Charging until" messages. Not sure why so many are printed out in a single slot. I think just a single one would suffice.
- [x] In these per-slot status log messages, include also "x kWh charged, y kWh remaining"
- [x] Also don't repeat the finished message. In that, include total charged amount so far, as well as total accumulated cost (based on the price calculations in the plan). You may have to track the accumulated cost in the state
- [x] In the charging finished message, also include the accumulated solar percentage. We're preparing to push these values to a database later. Just logging for now though.
- [x] In the log output after planning, include a summary of how much was the initial charge amount, how much has been charged so far (if any) and how much is left to be charged.
- [x] Add optional InfluxDB integration. I want to store the stats of each charge session after completion. I want charged kWh, total price, solar percentage.