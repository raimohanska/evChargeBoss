# Next staps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.

- TASK: In the current MQTT integration test: test that the relay changes occurred at expected times (we should know the plan)
- TASK: then create another test that tests that changing target time to earlier will trigger charging earlier
- TASK: test that change can make the charging start immediately (aborting current slot even)
- TASK: test changing time to a later time, aborts already started charge
- TASK: add linting and formatting
- TASK: refactor the integration test code into a nice form with clean abstractions and readable test. Test code must be high quality.
- TASK: remove the simulate mode altogether. It's no longer useful. Remove related test as well.
- TASK: now that tests coverage is good, refactor the loops. The runCharging method should not have a loop. Instead it should run a single slot only. The session loop should always plan, then run one slot. Make a comparison to see if the plan essentially change and print out if it did. Try to get the interface and abstractions cleaner.
- TASK: now review the whole codebase like a pro. Make refactorings and reorganize code cleanly.