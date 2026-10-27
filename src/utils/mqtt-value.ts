export function parseMqttValue(
  payload: string,
  jsonField?: string,
  options?: { allowBoolean?: boolean; onJsonError?: (error: unknown) => void },
): number | null {
  let raw: unknown;
  if (jsonField) {
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown> | null;
      raw = parsed?.[jsonField];
    } catch (error) {
      options?.onJsonError?.(error);
      return null;
    }
  } else {
    raw = payload.trim();
  }

  if (typeof raw === "boolean") return options?.allowBoolean ? (raw ? 1 : 0) : null;
  if (typeof raw === "string") {
    if (options?.allowBoolean) {
      if (raw === "true" || raw === "ON") return 1;
      if (raw === "false" || raw === "OFF") return 0;
    }
    raw = parseFloat(raw);
  }
  return typeof raw === "number" && isFinite(raw) ? raw : null;
}
