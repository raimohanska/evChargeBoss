import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseValue, formatSensorLine } from "../src/mqtt-to-influx/index.ts";
import type { SensorConfig } from "../src/mqtt-to-influx/config.ts";

const motion: SensorConfig = {
  name: "autotalli_motion",
  type: "motion",
  device: "autotalli",
  location: "autotalli",
  mqtt_topic: "sensors/autotalli/motion",
  unit: "",
};

const zigbeeMotion: SensorConfig = {
  name: "Autotallin liiketunnistin",
  type: "motion",
  device: "Zigbee PIR sensor",
  location: "autotalli",
  mqtt_topic: "zigbee2mqtt/Autotallin liiketunnistin",
  unit: "",
  json_field: "occupancy",
};

const temperature: SensorConfig = {
  name: "Radiator Return",
  type: "temperature",
  device: "heatpump",
  location: "patterit-paluu",
  mqtt_topic: "b0cbd8f1c4a4/HP/0001",
  unit: "°C",
};

describe("parseValue", () => {
  describe("ON/OFF strings (motion sensor)", () => {
    test("ON → 1", () => assert.equal(parseValue("ON", motion), 1));
    test("OFF → 0", () => assert.equal(parseValue("OFF", motion), 0));
  });

  describe("boolean strings", () => {
    test("true → 1 for motion", () => assert.equal(parseValue("true", motion), 1));
    test("false → 0 for motion", () => assert.equal(parseValue("false", motion), 0));
  });

  describe("numeric motion sensor", () => {
    test("any non-zero number → 1", () => assert.equal(parseValue("5", motion), 1));
    test("0 → 0", () => assert.equal(parseValue("0", motion), 0));
    test("1 → 1", () => assert.equal(parseValue("1", motion), 1));
  });

  describe("numeric temperature sensor", () => {
    test("integer string", () => assert.equal(parseValue("55", temperature), 55));
    test("float string", () => assert.equal(parseValue("21.5", temperature), 21.5));
    test("negative value", () => assert.equal(parseValue("-5.3", temperature), -5.3));
  });

  describe("json_field extraction", () => {
    test("boolean true → 1 for motion", () =>
      assert.equal(parseValue('{"occupancy":true,"linkquality":80}', zigbeeMotion), 1));
    test("boolean false → 0 for motion", () =>
      assert.equal(parseValue('{"occupancy":false,"linkquality":80}', zigbeeMotion), 0));
    test("numeric field", () => {
      const tempWithField: SensorConfig = { ...temperature, json_field: "temperature" };
      assert.equal(parseValue('{"temperature":21.5,"humidity":40}', tempWithField), 21.5);
    });
  });

  describe("invalid payloads", () => {
    test("unparseable string → null", () => assert.equal(parseValue("broken", temperature), null));
    test("empty string → null", () => assert.equal(parseValue("", temperature), null));
    test("invalid JSON with json_field → null", () =>
      assert.equal(parseValue("not-json", zigbeeMotion), null));
    test("missing json_field key → null", () =>
      assert.equal(parseValue('{"other":true}', zigbeeMotion), null));
    test("Infinity → null", () => assert.equal(parseValue("Infinity", temperature), null));
    test("-Infinity → null", () => assert.equal(parseValue("-Infinity", temperature), null));
  });
});

describe("formatSensorLine", () => {
  test("basic temperature sensor", () => {
    const line = formatSensorLine(temperature, 21.5, 1000);
    assert.equal(
      line,
      "temperature,name=Radiator\\ Return,device=heatpump,location=patterit-paluu,unit=°C value=21.5 1000",
    );
  });

  test("unit omitted when empty", () => {
    const line = formatSensorLine(motion, 1, 1000);
    assert.equal(
      line,
      "motion,name=autotalli_motion,device=autotalli,location=autotalli value=1 1000",
    );
  });

  test("spaces in name are escaped", () => {
    const sensor: SensorConfig = { ...temperature, name: "Warm water setpoint" };
    const line = formatSensorLine(sensor, 55, 1000);
    assert.match(line, /name=Warm\\ water\\ setpoint/);
  });

  test("commas in tags are escaped", () => {
    const sensor: SensorConfig = { ...temperature, device: "unit,A" };
    const line = formatSensorLine(sensor, 21, 1000);
    assert.match(line, /device=unit\\,A/);
  });
});
