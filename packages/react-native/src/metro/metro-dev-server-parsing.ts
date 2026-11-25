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
 * A TCP socket a local process listens on, kept as the address family the host reported it in: the
 * host part is a bare hostname (`127.0.0.1`, `::1`, `localhost`) and never carries URL brackets.
 */
export type ListeningSocket = Readonly<{ host: string; port: number }>;

const LOOPBACK_HOST = '127.0.0.1';
const IPV6_SEPARATOR = ':';

/**
 * The address to dial for a listening socket. A host with a colon is an IPv6 address and needs URL
 * brackets; an IPv4 or named host does not.
 */
export function socketUrl(socket: ListeningSocket, scheme: 'http' | 'https' = 'http'): URL {
  const host = socket.host.includes(IPV6_SEPARATOR) ? `[${socket.host}]` : socket.host;
  return new URL(`${scheme}://${host}:${socket.port}`);
}

/**
 * The listening sockets `lsof -nP -iTCP -sTCP:LISTEN -Fn` reports, deduplicated and ordered by port.
 * A line that names no socket, or a name whose port is not a plain number, is not a listening TCP
 * socket. `lsof` writes an IPv6 socket as `[::1]:8096`, and the brackets are not part of the host.
 */
export function parseLsofListeningSockets(stdout: string): ListeningSocket[] {
  return collectListeningSockets(stdout, (line) => (line.startsWith('n') ? line.slice(1) : ''));
}

/**
 * The listening sockets `netstat -an -p tcp` reports, deduplicated and ordered by port. Linux and
 * macOS number the same columns: local address fourth, state sixth.
 */
export function parseNetstatListeningSockets(stdout: string): ListeningSocket[] {
  return collectListeningSockets(stdout, (line) => {
    const columns = line.trim().split(/\s+/);
    if (!columns[0]?.startsWith('tcp') || columns[5] !== NETSTAT_LISTEN_STATE) return '';
    return columns[3] ?? '';
  });
}

function collectListeningSockets(
  stdout: string,
  addressOf: (line: string) => string,
): ListeningSocket[] {
  const sockets = new Map<string, ListeningSocket>();
  for (const line of stdout.split('\n')) {
    const socket = parseListeningSocket(addressOf(line));
    if (socket) sockets.set(`${socket.host}:${socket.port}`, socket);
  }
  return [...sockets.values()].sort((left, right) => left.port - right.port || byName(left, right));
}

/**
 * One socket address: a host and a plain-digit port, split at whichever separator comes last, since
 * the two hosts write them differently (`127.0.0.1:8081`, `127.0.0.1.8081`, `[::1]:8096`, `::1.8096`).
 * URL brackets are not part of the host. A name with no host before the separator — `:8081`, `*.*` —
 * names no address to dial; a wildcard host answers on this host's own addresses, so loopback reaches
 * it and the record keeps the dialling address rather than the wildcard.
 */
function parseListeningSocket(address: string): ListeningSocket | undefined {
  // An IPv6 name is bracketed and keeps its colons inside: `[::1]:8096`.
  const bracketEnd = address.lastIndexOf(']');
  if (bracketEnd > 0) {
    return namedSocket(
      address.slice(1, bracketEnd),
      parsePortToken(address.slice(bracketEnd + 1).replace(/^[:.]/, '')),
    );
  }
  const separator = Math.max(address.lastIndexOf('.'), address.lastIndexOf(':'));
  if (separator <= 0) return undefined;
  return namedSocket(address.slice(0, separator), parsePortToken(address.slice(separator + 1)));
}

function namedSocket(host: string, port: number | undefined): ListeningSocket | undefined {
  // A host left holding a bracket came from a name that is not an address at all, and a zone-scoped
  // one (`fe80::1%en0`) is no address `new URL` can dial.
  if (!host || port === undefined || /[[\]%]/.test(host)) return undefined;
  return { host: WILDCARD_HOSTS.has(host) ? LOOPBACK_HOST : host, port };
}

/** Names two sockets at the same port in a stable order, whatever the host's locale is. */
function byName(left: ListeningSocket, right: ListeningSocket): number {
  return left.host < right.host ? -1 : left.host > right.host ? 1 : 0;
}

/** Listeners bound to every address of this host, which loopback therefore reaches. */
const WILDCARD_HOSTS = new Set(['*', '::', '0.0.0.0']);

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
