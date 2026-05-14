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
import { StatusPublisher } from "../src/ev-charging/mqtt-status.ts";
import type { WattsUpdate } from "../src/ev-charging/charger.ts";
import { makeClock } from "../src/utils/timing-utils.ts";
import { makeTestConfig } from "./helpers/config.ts";

process.env.CACHE_DIR = fileURLToPath(new URL("./fixtures", import.meta.url));
process.env.CONFIG_FILE = fileURLToPath(new URL("./fixtures/config.json", import.meta.url));

/**
 * Regression: watts message routing must remain active for the whole session.
 * The test starts charging and then subscribes to wattsSource afterwards.
 */
test("wattsSource delivers updates after charging starts", async () => {
  const config = makeTestConfig();
  const mqtt = config.evCharging.mqtt!;

  const [sessionClient, helperClient] = await Promise.all([
    connectMqtt(config.mqtt!),
    connectMqtt(config.mqtt!),
  ]);

  const publisher = new StatusPublisher(sessionClient, config.evCharging);
  // Use a high-speedup clock so the 15-second power-measurement window
  // completes in ~1.5ms of real time.
  const clock = makeClock(10_000);
  const session = makeMqttSession(sessionClient, mqtt, publisher, clock);

  // Helper client subscribes to the charger command topic before sending ON.
  await new Promise<void>((res, rej) =>
    helperClient.subscribe(mqtt.chargerTopic, (e) => (e ? rej(e) : res())),
  );

  const publishPower = (w: number) =>
    helperClient.publish(mqtt.powerTopic, JSON.stringify({ [mqtt.powerField!]: w }));

  await session.driver.send(true);

  // Subscribe after the session has already started.
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
