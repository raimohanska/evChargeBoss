import { request as httpRequest } from "http";
import { request as httpsRequest } from "https";
import { URL } from "url";
import { makeLogger } from "./utils/log.ts";

const log = makeLogger("influx");

export interface InfluxConfig {
  url: string;
  token: string;
  org: string;
  bucket: string;
  tags?: Record<string, string>;
}

export interface SessionSummary {
  chargedKwh: number;
  totalCostEur: number;
  solarPct: number;
}

/** Escape a tag key or tag value per InfluxDB Line Protocol rules. */
export function escapeTagKeyValue(s: string): string {
  return s.replace(/[,= ]/g, "\\$&");
}

/**
 * Build a single Line Protocol line for a session summary.
 * Exported for unit-testing.
 */
export function formatLineProtocol(
  config: InfluxConfig,
  summary: SessionSummary,
  timestampMs: number,
): string {
  const measurement = "ev_charge_session";
  const tagStr =
    config.tags && Object.keys(config.tags).length > 0
      ? "," +
        Object.entries(config.tags)
          .map(([k, v]) => `${escapeTagKeyValue(k)}=${escapeTagKeyValue(v)}`)
          .join(",")
      : "";
  const fields = [
    `charged_kwh=${summary.chargedKwh}`,
    `total_cost_eur=${summary.totalCostEur}`,
    `solar_pct=${summary.solarPct}i`,
  ].join(",");
  return `${measurement}${tagStr} ${fields} ${timestampMs}`;
}

/** POST one Line Protocol line to InfluxDB v2 write API. */
export function writeLine(config: InfluxConfig, body: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const base = new URL(config.url);
    const basePath = base.pathname.replace(/\/$/, "");
    const path =
      `${basePath}/api/v2/write` +
      `?org=${encodeURIComponent(config.org)}` +
      `&bucket=${encodeURIComponent(config.bucket)}` +
      `&precision=ms`;
    const isHttps = base.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const bodyBuf = Buffer.from(body, "utf8");
    const req = reqFn(
      {
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path,
        method: "POST",
        headers: {
          Authorization: `Token ${config.token}`,
          "Content-Type": "text/plain; charset=utf-8",
          "Content-Length": bodyBuf.length,
        },
      },
      (res) => {
        res.resume(); // drain
        if (res.statusCode !== undefined && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`InfluxDB write failed: HTTP ${res.statusCode}`));
        }
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Check InfluxDB connectivity by hitting the unauthenticated /health endpoint.
 * Logs success or failure. Does not throw — a DB issue must not prevent startup.
 */
export async function checkInfluxHealth(config: InfluxConfig): Promise<void> {
  return new Promise((resolve) => {
    const base = new URL(config.url);
    const basePath = base.pathname.replace(/\/$/, "");
    const isHttps = base.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const req = reqFn(
      {
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path: `${basePath}/health`,
        method: "GET",
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => {
          try {
            const json = JSON.parse(body) as { status?: string };
            if (json.status === "pass") {
              log(
                `[Influx] Connected to ${config.url} (org: ${config.org}, bucket: ${config.bucket})`,
              );
            } else {
              log(
                `[Influx] WARNING: health check returned status "${json.status ?? "unknown"}" from ${config.url}`,
              );
            }
          } catch {
            log(
              `[Influx] WARNING: unexpected health response from ${config.url}: ${body.slice(0, 80)}`,
            );
          }
          resolve();
        });
      },
    );
    req.on("error", (err: Error) => {
      log(`[Influx] WARNING: cannot reach ${config.url} - ${err.message}`);
      resolve();
    });
    req.end();
  });
}

/**
 * Write session summary metrics to InfluxDB.
 * Errors are logged and swallowed so a DB outage never aborts a charge session.
 */
export async function writeSessionSummary(
  config: InfluxConfig,
  summary: SessionSummary,
): Promise<void> {
  const line = formatLineProtocol(config, summary, Date.now());
  try {
    await writeLine(config, line);
    log("[Influx] Session summary written.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`[Influx] ERROR: ${msg}`);
  }
}

/**
 * Query InfluxDB using Flux and return raw CSV string.
 * Exported for tests.
 */
export function queryInflux(config: InfluxConfig, flux: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const base = new URL(config.url);
    const basePath = base.pathname.replace(/\/$/, "");
    const path = `${basePath}/api/v2/query?org=${encodeURIComponent(config.org)}`;
    const isHttps = base.protocol === "https:";
    const reqFn = isHttps ? httpsRequest : httpRequest;
    const bodyBuf = Buffer.from(flux, "utf8");
    let csv = "";
    const req = reqFn(
      {
        hostname: base.hostname,
        port: base.port || (isHttps ? 443 : 80),
        path,
        method: "POST",
        headers: {
          Authorization: `Token ${config.token}`,
          "Content-Type": "application/vnd.flux",
          Accept: "application/csv",
          "Content-Length": bodyBuf.length,
        },
      },
      (res) => {
        if (res.statusCode !== undefined && (res.statusCode < 200 || res.statusCode >= 300)) {
          res.resume();
          reject(new Error(`InfluxDB query failed: HTTP ${res.statusCode}`));
          return;
        }
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (csv += chunk));
        res.on("end", () => resolve(csv));
      },
    );
    req.on("error", reject);
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * Parse the CSV returned by InfluxDB Flux query into an array of field→value maps.
 * Only data rows (not comment/annotation rows starting with #) are returned.
 */
export function parseFluxCsv(csv: string): Record<string, string>[] {
  const lines = csv.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
  if (lines.length < 2) return [];
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const cols = line.split(",");
    const row: Record<string, string> = {};
    headers.forEach((h, i) => (row[h.trim()] = (cols[i] ?? "").trim()));
    return row;
  });
}
