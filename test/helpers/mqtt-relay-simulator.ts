import type { MqttClient } from "../../src/ev-charging/mqtt-client.ts";
import type { MqttConfig } from "../../src/config.ts";
import type { Clock } from "../../src/utils/timing-utils.ts";
import { localDateTimeString } from "../../src/utils/date-time-format.ts";
import { realClock } from "../../src/utils/timing-utils.ts";
import assert from "node:assert/strict";

// 15 virtual minutes — absorbs MQTT roundtrip jitter at high speedup factors
const TIMING_TOLERANCE_MS = 15 * 60_000;
// Generous default: a 17-hour virtual gap takes ~15 s real at 4 000× speedup.
// 30 s leaves headroom for MQTT latency spikes while several sessions run
// concurrently against the same broker.
const DEFAULT_TIMEOUT_MS = 30_000;

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

  // Cumulative energy tracking (virtual-time based, grows at powerKw while relay is ON).
  private readonly powerKw = 3; // must match test config charging.powerKw
  private baseEnergyKwh = 0;
  private relayOnSince: Date | null = null;

  /** Current cumulative relay energy reading in kWh. */
  get totalEnergyKwh(): number {
    if (this.relayOnSince === null) return this.baseEnergyKwh;
    const ms = this.clock.now().getTime() - this.relayOnSince.getTime();
    return this.baseEnergyKwh + (this.powerKw * ms) / 3_600_000;
  }

  private readonly client: MqttClient;
  private readonly mqttConfig: MqttConfig;
  private readonly clock: Clock;

  private readonly suppressPower: boolean;

  /** Resolves when the charger-topic subscription is confirmed (SUBACK received). */
  readonly ready: Promise<void>;

  constructor(
    client: MqttClient,
    mqttConfig: MqttConfig,
    clock: Clock = realClock,
    options: { suppressPower?: boolean } = {},
  ) {
    this.client = client;
    this.mqttConfig = mqttConfig;
    this.clock = clock;
    this.suppressPower = options.suppressPower ?? false;
    this.ready = new Promise<void>((resolve, reject) => {
      client.subscribe(mqttConfig.chargerTopic, (err) => {
        if (err) reject(new Error(`Relay simulator subscribe failed: ${err.message}`));
        else resolve();
      });
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
    if (this.suppressPower) return; // simulating no car connected
    if (this.powerTimer) return; // already running
    this.relayOnSince = this.clock.now();
    const { powerTopic, powerField, energyField } = this.mqttConfig;
    const publish = () => {
      let msgStr: string;
      if (powerField !== undefined) {
        const payload: Record<string, number> = { [powerField]: 3000 };
        if (energyField) payload[energyField] = this.totalEnergyKwh;
        msgStr = JSON.stringify(payload);
      } else {
        msgStr = "3000";
      }
      this.client.publish(powerTopic, msgStr);
    };
    // Set timer first so the guard in stopEmittingPower can clear it before
    // the repeated publish fires.  Publish once immediately so waitForPlugIn
    // resolves within a single MQTT roundtrip instead of waiting for the first
    // setInterval tick (which at high speedup would advance virtual time by
    // many virtual minutes before charging begins).
    this.powerTimer = setInterval(publish, 20);
    publish();
  }

  private stopEmittingPower(): void {
    if (this.powerTimer) {
      clearInterval(this.powerTimer);
      this.powerTimer = null;
    }
    // Accumulate energy for the completed ON period.
    if (this.relayOnSince !== null) {
      const ms = this.clock.now().getTime() - this.relayOnSince.getTime();
      this.baseEnergyKwh += (this.powerKw * ms) / 3_600_000;
      this.relayOnSince = null;
    }
    // Emit zero watts so any active watt-listener sees the charger is off.
    this.client.publish(
      this.mqttConfig.powerTopic,
      this.mqttConfig.powerField !== undefined
        ? JSON.stringify({ [this.mqttConfig.powerField]: 0 })
        : "0",
    );
  }

  /** Number of OFF commands received since construction. */
  get offCount(): number {
    return this.states.filter((s) => !s).length;
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
              `Relay simulator: timed out after ${DEFAULT_TIMEOUT_MS}ms waiting for ${expected ? "ON" : "OFF"}`,
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
      `Expected relay ${expected ? "ON" : "OFF"} but got ${actual ? "ON" : "OFF"}`,
    );
    return this.timestamps[this.consumedIdx - 1];
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
