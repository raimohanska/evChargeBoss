import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseValue, formatSensorLine } from "../src/mqtt-to-influx/index.ts";
import type { SensorConfig } from "../src/mqtt-to-influx/config.ts";
import { SensorConfig as SensorConfigSchema } from "../src/mqtt-to-influx/config.ts";
import { parseMqttValue } from "../src/utils/mqtt-value.ts";

process.env.EVCHARGEBOSS_NO_FETCH = "1";

describe("shared MQTT value parsing", () => {
  test("plain temperatures remain supported", () => {
    assert.equal(parseMqttValue(" 21.5 "), 21.5);
    assert.equal(parseMqttValue("-5.3"), -5.3);
    assert.equal(parseMqttValue("0"), 0);
  });

  test("JSON temperatures support numbers and numeric strings", () => {
    assert.equal(parseMqttValue('{"temperature":21.5,"humidity":40}', "temperature"), 21.5);
    assert.equal(parseMqttValue('{"temperature":"-5.3"}', "temperature"), -5.3);
    assert.equal(parseMqttValue('{"temperature":0}', "temperature"), 0);
  });

  test("invalid or missing temperatures return null", () => {
    for (const payload of [
      "not-json",
      "null",
      "{}",
      '{"temperature":null}',
      '{"temperature":{}}',
      '{"temperature":[]}',
      '{"temperature":"broken"}',
      '{"temperature":"Infinity"}',
      '{"temperature":1e400}',
    ]) {
      assert.equal(parseMqttValue(payload, "temperature"), null, payload);
    }
    for (const payload of ["", "broken", "Infinity", "-Infinity"]) {
      assert.equal(parseMqttValue(payload), null, payload);
    }
  });

  test("JSON errors can be logged by the caller", () => {
    const errors: unknown[] = [];
    assert.equal(
      parseMqttValue("broken", "temperature", { onJsonError: (error) => errors.push(error) }),
      null,
    );
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof SyntaxError);
  });

  test("temperatures reject boolean payloads", () => {
    for (const payload of ["true", "false", "ON", "OFF"]) {
      assert.equal(parseMqttValue(payload), null);
      assert.equal(parseMqttValue(JSON.stringify({ temperature: payload }), "temperature"), null);
    }
    assert.equal(parseMqttValue('{"temperature":true}', "temperature"), null);
    assert.equal(parseMqttValue('{"temperature":false}', "temperature"), null);
  });
});

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
  jsonField: "occupancy",
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

  describe("jsonField extraction", () => {
    test("configuration accepts jsonField", () => {
      assert.equal(SensorConfigSchema.parse(zigbeeMotion).jsonField, "occupancy");
    });
    test("boolean true → 1 for motion", () =>
      assert.equal(parseValue('{"occupancy":true,"linkquality":80}', zigbeeMotion), 1));
    test("boolean false → 0 for motion", () =>
      assert.equal(parseValue('{"occupancy":false,"linkquality":80}', zigbeeMotion), 0));
    test("numeric field", () => {
      const tempWithField: SensorConfig = { ...temperature, jsonField: "temperature" };
      assert.equal(parseValue('{"temperature":21.5,"humidity":40}', tempWithField), 21.5);
    });
  });

  describe("invalid payloads", () => {
    test("unparseable string → null", () => assert.equal(parseValue("broken", temperature), null));
    test("empty string → null", () => assert.equal(parseValue("", temperature), null));
    test("invalid JSON with jsonField → null", () =>
      assert.equal(parseValue("not-json", zigbeeMotion), null));
    test("missing jsonField key → null", () =>
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

  test("empty location tag omitted (avoids InfluxDB 400)", () => {
    const sensor: SensorConfig = { ...temperature, location: "" };
    const line = formatSensorLine(sensor, 27.5, 1000);
    assert.doesNotMatch(line, /location=/);
    assert.match(line, /^temperature,/);
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
