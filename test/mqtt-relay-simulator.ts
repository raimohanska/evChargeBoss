import type { MqttClient } from "../src/mqtt-client.ts";
import type { MqttConfig } from "../src/config.ts";
import assert from "node:assert/strict";

/**
 * Simulates a physical relay sitting on MQTT.
 *
 * Subscribes to the charger command topic and tracks every ON/OFF command in
 * order.  When turned ON it begins publishing power readings so waitForPlugIn
 * resolves; when turned OFF it stops.
 *
 * assertNextState(expected) consumes the next command from the queue and fails
 * if it does not match.  If no command has arrived yet it waits up to
 * timeoutMs milliseconds before rejecting.
 */
export class MqttRelaySimulator {
  private readonly states: boolean[] = [];
  private consumedIdx = 0;
  private pending: {
    resolve: (s: boolean) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private powerTimer: ReturnType<typeof setInterval> | null = null;

  private readonly client: MqttClient
  private readonly mqttConfig: MqttConfig

  constructor(
    client: MqttClient,
    mqttConfig: MqttConfig,
  ) {
    this.client = client
    this.mqttConfig = mqttConfig
    client.subscribe(mqttConfig.chargerTopic, (err) => {
      if (err) throw new Error(`Relay simulator subscribe failed: ${err.message}`);
    });
    client.on("message", (topic: string, payload: Buffer) => {
      if (topic !== mqttConfig.chargerTopic) return;
      const str = payload.toString();
      if (str === mqttConfig.onPayload) this.onCommand(true);
      else if (str === mqttConfig.offPayload) this.onCommand(false);
    });
  }

  private onCommand(on: boolean): void {
    this.states.push(on);
    if (on) this.startEmittingPower();
    else    this.stopEmittingPower();

    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(on);
    }
  }

  private startEmittingPower(): void {
    if (this.powerTimer) return; // already stopped (OFF came in during delay)
    this.powerTimer = setInterval(() => {
      this.client.publish(
        this.mqttConfig.powerTopic,
        JSON.stringify({ [this.mqttConfig.powerField]: 3000 }),
      );
    }, 100);  
  }

  private stopEmittingPower(): void {
    if (this.powerTimer) {
      clearInterval(this.powerTimer);
      this.powerTimer = null;
    }    
    // Emit zero watts so any active watt-listener sees the charger is off.
    this.client.publish(
      this.mqttConfig.powerTopic,
      JSON.stringify({ [this.mqttConfig.powerField]: 0 }),
    );
  }

  /**
   * Waits for the next relay command and asserts it equals `expected`.
   * Reads from the already-received queue first; blocks if the queue is empty.
   */
  async assertNextState(expected: boolean, timeoutMs = 2000): Promise<void> {
    let actual: boolean;

    if (this.consumedIdx < this.states.length) {
      actual = this.states[this.consumedIdx++];
    } else {
      actual = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(
          () => {
            this.pending = null;
            reject(new Error(
              `Relay simulator: timed out after ${timeoutMs}ms waiting for state ${expected ? "ON" : "OFF"}`,
            ));
          },
          timeoutMs,
        );
        this.pending = { resolve, reject, timer };
      });
      this.consumedIdx++;
    }

    assert.equal(
      actual, expected,
      `Expected relay ${expected ? "ON" : "OFF"} but received ${actual ? "ON" : "OFF"}`,
    );
  }

  cleanup(): void {
    this.stopEmittingPower();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error("MqttRelaySimulator cleaned up while assertion was pending"));
      this.pending = null;
    }
    this.client.unsubscribe(this.mqttConfig.chargerTopic);
  }
}
