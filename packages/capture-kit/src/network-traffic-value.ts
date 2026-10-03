export function parseNetworkStatusCode(line: string): number | null {
  for (const pattern of [
    /\bstatus(?:Code)?["'=: ]+([1-5]\d{2})\b/i,
    /\bresponse(?:\s+code)?["'=: ]+([1-5]\d{2})\b/i,
    /\bHTTP\/[0-9.]+\s+([1-5]\d{2})\b/i,
  ]) {
    const match = pattern.exec(line);
    if (!match) continue;
    const value = Number.parseInt(match[1] ?? '', 10);
    if (Number.isInteger(value)) return value;
  }
  return null;
}

export function parseNetworkTimestamp(line: string): string | undefined {
  return (
    /\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z)?\b/.exec(line)?.[0] ??
    /\b\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d+\b/.exec(line)?.[0]
  );
}

export function parseEmbeddedNetworkJson(line: string): Record<string, unknown> | null {
  const start = line.indexOf('{');
  const end = line.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed: unknown = JSON.parse(line.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function readNetworkJsonString(
  value: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const next = value?.[key];
    if (typeof next === 'string' && next.trim()) return next.trim();
  }
  return undefined;
}

export function readNetworkJsonNumber(
  value: Record<string, unknown> | null,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const next = value?.[key];
    if (typeof next === 'number' && Number.isInteger(next)) return next;
    if (typeof next === 'string' && /^\d{3}$/.test(next.trim())) {
      return Number.parseInt(next, 10);
    }
  }
  return null;
}

export function readNetworkHeaders(
  line: string,
  json: Record<string, unknown> | null,
): string | undefined {
  const value = json?.headers ?? json?.requestHeaders ?? json?.responseHeaders;
  return value === undefined
    ? /\bheaders?["'=: ]+(\{.*\})/i.exec(line)?.[1]?.trim()
    : stringifyNetworkValue(value);
}

export function readNetworkBody(
  line: string,
  json: Record<string, unknown> | null,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (json?.[key] !== undefined) return stringifyNetworkValue(json[key]);
    const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    const match = new RegExp(`\\b${escaped}["'=: ]+(.+)$`, 'i').exec(line);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function stringifyNetworkValue(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
