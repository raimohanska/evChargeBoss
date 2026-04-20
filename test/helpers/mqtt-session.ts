import type { Config } from "../../src/config.ts";
import { connectMqtt, makeMqttSession } from "../../src/mqtt-client.ts";
import { createPublisher } from "../../src/mqtt-status.ts";
import { makeClock } from "../../src/utils.ts";
import { runMainLoop } from "../../src/main-loop.ts";
import { IncompleteDataError } from "../../src/errors.ts";
import { STATUS } from "../../src/mqtt-status.ts";
import { MqttRelaySimulator } from "./mqtt-relay-simulator.ts";
import { makeTestConfig } from "./config.ts";

function errorStatus(err: unknown): string {
  if (err instanceof IncompleteDataError) return STATUS.waitingForSpot;
  return STATUS.error(err instanceof Error ? err.message : String(err));
}

export interface MqttTestSession {
  loopPromise: Promise<void>;
  relay: MqttRelaySimulator;
  teardown(): void;
}

export async function startMqttSession(from: Date, speedup: number): Promise<MqttTestSession> {
  const config = makeTestConfig() 
  const [sessionClient, relayClient] = await Promise.all([
    connectMqtt(config.mqtt!),
    connectMqtt(config.mqtt!),
  ]);

  const publisher = createPublisher(config);
  const session = makeMqttSession(sessionClient, config.mqtt!, publisher);
  const clock = makeClock(speedup, from);
  const relay = new MqttRelaySimulator(relayClient, config.mqtt!, clock);

  const loopPromise = runMainLoop(session, publisher, config, from, errorStatus, clock);

  return {
    loopPromise,
    relay,
    teardown() {
      relay.cleanup();
      sessionClient.end();
      relayClient.end();
    },
  };
}
