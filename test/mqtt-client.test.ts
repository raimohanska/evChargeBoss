/**
 * Unit/integration tests for makeMqttSession.
 *
 * Requires a Mosquitto broker on localhost:1883.
 * Start one with: docker compose up -d
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { connectMqtt, makeMqttSession } from "../src/ev-charging/mqtt-client.ts";
import { createPublisher } from "../src/ev-charging/mqtt-status.ts";
import type { WattsUpdate } from "../src/ev-charging/charger.ts";
import { makeTestConfig } from "./helpers/config.ts";

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

/**
 * Regression: msgHandler was scoped inside waitForStart() and torn down in its
 * finally block.  After waitForStart() returned, no MQTT messages reached
 * wattsListeners, so wattsSource.subscribe() callbacks were never invoked.
 *
 * The test subscribes to wattsSource AFTER waitForStart() has resolved and
 * asserts that a subsequent power message is delivered.  With the old code the
 * receivedPromise would never resolve.
 */
test("wattsSource delivers updates after waitForStart() resolves", async () => {
  const config = makeTestConfig();
  const mqtt = config.evCharging.charging.mqtt!;

  const [sessionClient, helperClient] = await Promise.all([connectMqtt(mqtt), connectMqtt(mqtt)]);

  const publisher = createPublisher(config.evCharging);
  const session = makeMqttSession(sessionClient, mqtt, publisher);

  // Helper client subscribes to the charger command topic so the ON publish
  // inside waitForStart() doesn't fail due to no subscribers being present.
  await new Promise<void>((res, rej) =>
    helperClient.subscribe(mqtt.chargerTopic, (e) => (e ? rej(e) : res())),
  );

  const publishPower = (w: number) =>
    helperClient.publish(mqtt.powerTopic, JSON.stringify({ [mqtt.powerField]: w }));

  // Continuously publish power so waitForPlugIn reliably receives a reading
  // above threshold regardless of subscribe timing — same approach used by
  // MqttRelaySimulator (setInterval + immediate publish).
  const powerInterval = setInterval(() => publishPower(mqtt.powerThresholdW + 100), 50);
  try {
    await session.waitForStart();
  } finally {
    clearInterval(powerInterval);
  }

  // Subscribe to wattsSource AFTER waitForStart() has returned.
  // With the old bug the msgHandler was already torn down, so this callback
  // would never fire.
  let received: WattsUpdate | null = null;
  const receivedPromise = new Promise<void>((resolve) => {
    session.wattsSource!.subscribe((u) => {
      received = u;
      resolve();
    });
  });

  publishPower(2500);
  await receivedPromise;

  assert.equal(received!.watts, 2500);

  session.end();
  helperClient.end(true);
});
