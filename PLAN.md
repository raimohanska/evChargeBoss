# Next steps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.

- [ ] TASK: investigate whether the implementation relies on the "watts" being "retained" in MQTT broker. I mean if the watts doesn't change between two slots, we shouldn't start the next slot as "waiting" if the previous ended as "charging"
- [ ] TASK: include testing the published "Charged energy" MQTT field in integration tests. 