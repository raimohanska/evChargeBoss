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
process.env.EVCHARGEBOSS_NO_FETCH = "1";

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

/**
 * Regression: a transient error emitted after a successful connect must NOT
 * tear down the client. Previously connectMqtt left its connection-time
 * `once("error")` handler attached, so the first post-connect error (e.g. a
 * write EPIPE) called client.end() and permanently disabled auto-reconnect.
 */
test("client survives a post-connect error and stays connected", async () => {
  const config = makeTestConfig();
  const client = await connectMqtt(config.mqtt!);

  assert.equal(client.connected, true);

  // Simulate a transient socket error after connecting.
  client.emit("error", new Error("write EPIPE"));

  // With the bug, client.end() would have run and put the client into the
  // disconnecting/ended state. It must remain connected and not disconnecting.
  assert.equal(client.disconnecting, false);
  assert.equal(client.connected, true);

  // The client must still be usable for publishing.
  await new Promise<void>((resolve, reject) =>
    client.publish("evchargeboss/test/regression", "ok", (err) => (err ? reject(err) : resolve())),
  );

  client.end(true);
});
