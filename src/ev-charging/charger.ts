export interface ChargerDriver {
  send(on: boolean): Promise<void>;
}

export interface WattsUpdate {
  watts: number;
  energyKwh?: number;
}

export interface WattsSource {
  subscribe(cb: (update: WattsUpdate) => void): () => void;
}

export interface HoldSource {
  subscribe(cb: (held: boolean) => void): () => void;
}

export interface ChargingSession {
  driver: ChargerDriver;
  wattsSource?: WattsSource;
  holdSource?: HoldSource;
  end(): void;
}
