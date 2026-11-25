import path from 'node:path';

/**
 * The pure reads behind dev-server discovery: what a host's command output, an app's stored
 * settings, or a `/status` response says. Each function takes text and answers one question, so the
 * decision branches are testable without a process, a file, or a socket.
 */

const IOS_JS_LOCATION_KEY = 'RCT_jsLocation';
const IOS_PACKAGER_SCHEME_KEY = 'RCT_packager_scheme';
const MAX_PORT = 65_535;
const NETSTAT_LISTEN_STATE = 'LISTEN';

/** The body a running React Native dev server answers on `/status`. */
const METRO_STATUS_READY_TEXT = 'packager-status:running';

export function isMetroStatusBody(text: string): boolean {
  return text.includes(METRO_STATUS_READY_TEXT);
}

/**
 * The project root a dev server reports in `X-React-Native-Project-Root`. Expo percent-encodes the
 * value and the React Native CLI does not, so an encoded value is decoded and a malformed one kept.
 */
export function parseMetroProjectRootHeader(value: string | null): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.includes('%')) return trimmed;
  try {
    return decodeURIComponent(trimmed) || undefined;
  } catch {
    return trimmed;
  }
}

/**
 * The listening ports `lsof -nP -iTCP -sTCP:LISTEN -Fn` reports, deduplicated and ascending. A line
 * that names no socket, or a name whose port is not a plain number, is not a listening TCP socket.
 */
export function parseLsofListeningPorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('n')) continue;
    const port = parsePortFromSocketName(line.slice(1));
    if (port !== undefined) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/**
 * The listening ports `netstat -an -p tcp` reports, deduplicated and ascending. Linux and macOS
 * number the same columns: local address fourth, state sixth. Their address formats differ — Linux
 * writes `127.0.0.1:8081`, macOS `127.0.0.1.8081` — so either trailing separator names the port.
 */
export function parseNetstatListeningPorts(stdout: string): number[] {
  const ports = new Set<number>();
  for (const line of stdout.split('\n')) {
    const columns = line.trim().split(/\s+/);
    if (!columns[0]?.startsWith('tcp')) continue;
    if (columns[5] !== NETSTAT_LISTEN_STATE) continue;
    const port = parsePortFromNetstatAddress(columns[3] ?? '');
    if (port !== undefined) ports.add(port);
  }
  return [...ports].sort((left, right) => left - right);
}

/** The port a socket name such as `127.0.0.1:8081` ends with. */
export function parsePortFromSocketName(name: string): number | undefined {
  const separator = name.lastIndexOf(':');
  if (separator <= 0) return undefined;
  return parsePortToken(name.slice(separator + 1));
}

/**
 * The port a `netstat` local address ends with, after either separator the two platforms use. A
 * wildcard address such as `*.*` names no port.
 */
function parsePortFromNetstatAddress(address: string): number | undefined {
  const withoutBrackets = address.replace(/\]$/, '');
  const separator = Math.max(withoutBrackets.lastIndexOf(':'), withoutBrackets.lastIndexOf('.'));
  if (separator <= 0) return undefined;
  return parsePortToken(withoutBrackets.slice(separator + 1));
}

/**
 * The dev server an iOS app stored in its own preferences: `RCT_jsLocation` as `host:port`, with
 * `RCT_packager_scheme` selecting `https` when it says so. Anything else — no settings, no key, an
 * empty key, a non-string value, or a host:port whose port is not a plain number — is no server.
 */
export function parseAppReportedServerUrl(settingsJson: string): URL | undefined {
  const settings = parseJsonObject(settingsJson);
  if (!settings) return undefined;
  const reported = asNonEmptyString(settings[IOS_JS_LOCATION_KEY]);
  if (!reported) return undefined;
  const scheme = settings[IOS_PACKAGER_SCHEME_KEY] === 'https' ? 'https' : 'http';
  return parseHostAndPort(reported, scheme);
}

/**
 * A `host:port` address, as React Native stores it. The port token must be plain digits:
 * `127.0.0.1:8081junk` is a broken value, not a hint to reload port 8081.
 */
function parseHostAndPort(value: string, scheme: 'http' | 'https'): URL | undefined {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return undefined;
  const host = value.slice(0, separator);
  const port = parsePortToken(value.slice(separator + 1));
  if (!host || port === undefined) return undefined;
  try {
    return new URL(`${scheme}://${host}:${port}`);
  } catch {
    return undefined;
  }
}

/** Whether two project roots name the same directory, or one holds the other. */
export function projectRootsOverlap(left: string, right: string): boolean {
  return isSameOrInsidePath(left, right) || isSameOrInsidePath(right, left);
}

function isSameOrInsidePath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** A port token that is plain digits and names a real port. */
function parsePortToken(token: string): number | undefined {
  const trimmed = token.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const port = Number(trimmed);
  return port >= 1 && port <= MAX_PORT ? port : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
