import type { MqttClient } from '../../src/mqtt-client.ts';
import type { MqttConfig } from '../../src/config.ts';
import type { Clock } from '../../src/utils.ts';
import { realClock, localDateTimeString } from '../../src/utils.ts';
import assert from 'node:assert/strict';

// 10 virtual minutes — absorbs MQTT roundtrip jitter at high speedup factors
const TIMING_TOLERANCE_MS = 10 * 60_000;
// Generous default: a 17-hour virtual gap takes ~6 s real at 10 000× speedup
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Simulates a physical relay sitting on MQTT.
 *
 * Subscribes to the charger command topic and tracks every ON/OFF command in order.
 * When turned ON it begins publishing power readings so waitForPlugIn resolves;
 * when turned OFF it stops.
 *
 * assertOn(expectedDateTime) — wait for the next ON and assert it arrived ~at that time.
 * assertOff(beforeDateTime)  — wait for the next OFF and assert it arrived before that time.
 */
export class MqttRelaySimulator {
  private readonly states: boolean[] = [];
  private readonly timestamps: Date[] = [];
  private consumedIdx = 0;
  private pending: {
    resolve: (s: boolean) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private powerTimer: ReturnType<typeof setInterval> | null = null;

  private readonly client: MqttClient;
  private readonly mqttConfig: MqttConfig;
  private readonly clock: Clock;

  /** Resolves when the charger-topic subscription is confirmed (SUBACK received). */
  readonly ready: Promise<void>;

  constructor(
    client: MqttClient,
    mqttConfig: MqttConfig,
    clock: Clock = realClock,
  ) {
    this.client = client;
    this.mqttConfig = mqttConfig;
    this.clock = clock;
    this.ready = new Promise<void>((resolve, reject) => {
      client.subscribe(mqttConfig.chargerTopic, (err) => {
        if (err)
          reject(new Error(`Relay simulator subscribe failed: ${err.message}`));
        else resolve();
      });
    });
    client.on('message', (topic: string, payload: Buffer) => {
      if (topic !== mqttConfig.chargerTopic) return;
      const str = payload.toString();
      if (str === mqttConfig.onPayload) this.onCommand(true);
      else if (str === mqttConfig.offPayload) this.onCommand(false);
    });
  }

  private onCommand(on: boolean): void {
    this.states.push(on);
    this.timestamps.push(this.clock.now());
    if (on) this.startEmittingPower();
    else this.stopEmittingPower();

    const p = this.pending;
    if (p) {
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(on);
    }
  }

  private startEmittingPower(): void {
    if (this.powerTimer) return; // already running
    const publish = () =>
      this.client.publish(
        this.mqttConfig.powerTopic,
        JSON.stringify({ [this.mqttConfig.powerField]: 3000 }),
      );
    // Set timer first so the guard in stopEmittingPower can clear it before
    // the repeated publish fires.  Publish once immediately so waitForPlugIn
    // resolves within a single MQTT roundtrip instead of waiting for the first
    // setInterval tick (which at 10 000× speedup would advance virtual time by
    // ~16 virtual minutes before charging begins).
    this.powerTimer = setInterval(publish, 100);
    publish();
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

  /** Wait for next relay command, assert it is ON, assert it arrived ~at expectedDateTime ("YYYY-MM-DDTHH:MM"). */
  async assertOn(expectedDateTime: string): Promise<void> {
    const t = await this.nextCommand(true);
    const expected = new Date(`${expectedDateTime}:00`);
    assert.ok(
      Math.abs(t.getTime() - expected.getTime()) < TIMING_TOLERANCE_MS,
      `Expected relay ON at ~${expectedDateTime}, arrived at ${localDateTimeString(t)}`,
    );
  }

  /** Wait for next relay command, assert it is OFF, assert it arrived strictly before beforeDateTime ("YYYY-MM-DDTHH:MM"). */
  async assertOff(beforeDateTime: string): Promise<void> {
    const t = await this.nextCommand(false);
    const before = new Date(`${beforeDateTime}:00`);
    assert.ok(
      t < before,
      `Expected relay OFF before ${beforeDateTime}, arrived at ${localDateTimeString(t)}`,
    );
  }

  /** Wait for next relay command, assert it is ON, assert it arrived strictly before beforeDateTime ("YYYY-MM-DDTHH:MM"). */
  async assertOnBefore(beforeDateTime: string): Promise<void> {
    const t = await this.nextCommand(true);
    const before = new Date(`${beforeDateTime}:00`);
    assert.ok(
      t < before,
      `Expected relay ON before ${beforeDateTime}, arrived at ${localDateTimeString(t)}`,
    );
  }

  private async nextCommand(expected: boolean): Promise<Date> {
    let actual: boolean;

    if (this.consumedIdx < this.states.length) {
      actual = this.states[this.consumedIdx++];
    } else {
      actual = await new Promise<boolean>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.pending = null;
          reject(
            new Error(
              `Relay simulator: timed out after ${DEFAULT_TIMEOUT_MS}ms waiting for ${expected ? 'ON' : 'OFF'}`,
            ),
          );
        }, DEFAULT_TIMEOUT_MS);
        this.pending = { resolve, reject, timer };
      });
      this.consumedIdx++;
    }

    assert.equal(
      actual,
      expected,
      `Expected relay ${expected ? 'ON' : 'OFF'} but got ${actual ? 'ON' : 'OFF'}`,
    );
    return this.timestamps[this.consumedIdx - 1];
  }

  cleanup(): void {
    this.stopEmittingPower();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(
        new Error('MqttRelaySimulator cleaned up while assertion was pending'),
      );
      this.pending = null;
    }
    this.client.unsubscribe(this.mqttConfig.chargerTopic);
  }
}
