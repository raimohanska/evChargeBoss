# Next steps

Each step needs careful planning and must result in a solid state where all tests pass, app can be built and run.

- [x] Clean up all MQTT status messages from characters such as pipe, euro symbol. These don't seem to work with Home Assistant.
- [x] Implement a "Charge now" control. Ideal would be a simple button in HA, that you could use to set charge target to NOW + 2 hours (configurable in config file). This should start charging pretty much immediately in practice. Think carefully! If my logic isn't right, tell me.
