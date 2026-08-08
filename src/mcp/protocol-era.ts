import { AppError } from '@agent-device/kernel/errors';
import { readVersion } from '../utils/version.ts';

/**
 * MCP has two protocol eras, and agent-device serves both from one stdio process
 * (the spec's "dual-era server", MCP 2026-07-28 § Versioning and Compatibility).
 *
 * - **legacy** (`2025-11-25` and earlier): the client negotiates once via `initialize`,
 *   and every later request inherits that session state.
 * - **modern** (`2026-07-28`+): stateless. Each request carries its own protocol version
 *   and client capabilities in `_meta`, there is no handshake, and results are tagged
 *   with `resultType`.
 *
 * Era membership follows the *declared revision*, not merely the presence of `_meta`: a
 * revision is served on its own wire contract, so a request declaring `2025-11-25` gets
 * the legacy result shape even though it used modern framing to say so. Legacy responses
 * stay byte-identical to what earlier releases sent.
 */
export type ProtocolEra = 'legacy' | 'modern';

/** Newest stateless revision, and the one `server/discover` answers for. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/** Revisions served statelessly, newest first. */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = [MODERN_PROTOCOL_VERSION];

/**
 * Revisions served through the `initialize` handshake, newest first.
 *
 * Scoped to what this server actually provides rather than every published revision: a
 * tools-only server's surface (`tools/list`, `tools/call`, `outputSchema`,
 * `structuredContent`) is identical across these and `2026-07-28`. Revisions before
 * `2025-06-18` predate `outputSchema`/`structuredContent`, which every typed tool here
 * returns, so they are not claimed.
 */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18'];

/** Answer for a handshake whose requested revision we do not serve on the legacy wire. */
export const PREFERRED_LEGACY_PROTOCOL_VERSION = '2025-11-25';

/** Every revision we implement, newest first — the list a client may choose from. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
];

/** JSON-RPC error code for a declared revision this server does not implement. */
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

/** Modern-only RPC: it does not exist in any legacy revision. */
const DISCOVER_METHOD = 'server/discover';

/**
 * Methods `2026-07-28` removed. They stay available to legacy-framed requests, which
 * still need the handshake and the keepalive, and are unknown methods in the modern era.
 */
const LEGACY_ONLY_METHODS: ReadonlySet<string> = new Set(['initialize', 'ping']);

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const SERVER_INFO_META_KEY = 'io.modelcontextprotocol/serverInfo';

const MCP_SERVER_NAME = 'agent-device';

/**
 * Freshness hint for the results that depend only on the installed binary.
 *
 * Both `tools/list` and `server/discover` are derived from the command descriptor
 * registry alone — no user config, no device state, no session — so they are constant for
 * a given version and `cacheScope: 'public'` is honest: nothing in them is user-specific.
 * (Config-backed defaults are resolved per `tools/call`, never baked into the schemas.)
 * Clients re-launch the process on upgrade, which is what invalidates the entry.
 */
export const STATIC_RESULT_CACHE_TTL_MS = 3_600_000;

export type CacheableResultFields = {
  ttlMs: number;
  cacheScope: 'public' | 'private';
};

export class UnsupportedProtocolVersionError extends Error {
  readonly requested: string;

  constructor(requested: string) {
    super(
      `Unsupported MCP protocol version: ${requested}. Supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(', ')}.`,
    );
    this.requested = requested;
  }

  get data(): { supported: readonly string[]; requested: string } {
    return { supported: SUPPORTED_PROTOCOL_VERSIONS, requested: this.requested };
  }
}

/**
 * Classifies one request, rejecting revisions we do not implement and modern framing that
 * omits its required metadata.
 *
 * A declared revision picks the era, so `2025-*` declared through modern `_meta` is still
 * answered on the legacy wire contract. `server/discover` exists only in the modern era,
 * so it requires a modern revision rather than being promoted by default — leniency there
 * would answer a `DiscoverResult` that its own schema forbids.
 */
export function resolveProtocolEra(method: string, params: unknown): ProtocolEra {
  const meta = asRecord(asRecord(params)._meta);
  const declared = stringField(meta, PROTOCOL_VERSION_META_KEY);

  if (declared === undefined) {
    if (method === DISCOVER_METHOD) {
      throw new AppError(
        'INVALID_ARGS',
        `Expected _meta["${PROTOCOL_VERSION_META_KEY}"] on ${DISCOVER_METHOD}.`,
      );
    }
    return 'legacy';
  }

  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
    throw new UnsupportedProtocolVersionError(declared);
  }
  // Both keys are required on a modern request; a half-declared `_meta` is malformed
  // rather than a shape to keep working.
  if (!isRecord(meta[CLIENT_CAPABILITIES_META_KEY])) {
    throw new AppError(
      'INVALID_ARGS',
      `Expected _meta["${CLIENT_CAPABILITIES_META_KEY}"] to be an object.`,
    );
  }
  // Client identity is optional, but a supplied one still has to be an `Implementation`:
  // omitting it is a choice, misdeclaring it is a malformed request.
  const clientInfo = meta[CLIENT_INFO_META_KEY];
  if (clientInfo !== undefined && !isImplementation(clientInfo)) {
    throw new AppError(
      'INVALID_ARGS',
      `Expected _meta["${CLIENT_INFO_META_KEY}"] to be a valid Implementation.`,
    );
  }
  if (!MODERN_PROTOCOL_VERSIONS.includes(declared)) {
    if (method === DISCOVER_METHOD) throw new UnsupportedProtocolVersionError(declared);
    return 'legacy';
  }
  return 'modern';
}

/**
 * Legacy `initialize` version negotiation: echo the client's revision when we serve it on
 * this wire, otherwise name the newest legacy revision we do. Answering with an
 * unrequested version tells a pinned client to disconnect, so the echo is the
 * interoperable branch. Modern revisions are not echoed — they have no handshake, so
 * agreeing to one here would promise a contract this reply cannot establish.
 */
export function negotiateLegacyProtocolVersion(params: unknown): string {
  const requested = stringField(asRecord(params), 'protocolVersion');
  if (requested !== undefined && LEGACY_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return PREFERRED_LEGACY_PROTOCOL_VERSION;
}

/**
 * Whether the resolved era removed this method. A modern-framed request reaching
 * `initialize` or `ping` is calling a method its own revision deleted, so it gets the
 * unknown-method error rather than a `resultType: "complete"` envelope wrapped around a
 * legacy handshake reply.
 */
export function isMethodRemovedInEra(method: string, era: ProtocolEra): boolean {
  return era === 'modern' && LEGACY_ONLY_METHODS.has(method);
}

export function serverInfo(): { name: string; version: string } {
  return { name: MCP_SERVER_NAME, version: readVersion() };
}

/**
 * Applies the modern result envelope: every 2026-07-28 result carries `resultType`, and
 * servers identify themselves in `_meta`. Legacy results pass through untouched.
 */
export function finalizeResult(result: unknown, era: ProtocolEra): unknown {
  if (era === 'legacy' || result === null || typeof result !== 'object') return result;
  return {
    resultType: 'complete',
    ...(result as Record<string, unknown>),
    _meta: {
      ...(result as { _meta?: Record<string, unknown> })._meta,
      [SERVER_INFO_META_KEY]: serverInfo(),
    },
  };
}

/** Cache hints belong to the modern `CacheableResult` shape only. */
export function cacheFields(era: ProtocolEra, ttlMs: number): CacheableResultFields | undefined {
  return era === 'modern' ? { ttlMs, cacheScope: 'public' } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a value is a valid `Implementation`: `name` and `version` are required, and
 * every other recognized field is type-checked when present. Unrecognized keys pass —
 * `_meta` payloads carry extension fields, and rejecting those would reject the future.
 *
 * Required means *present and a string*, not non-empty: the schema declares plain
 * `string` with no minimum length, so `{name: "", version: ""}` is a conforming
 * `Implementation` and refusing it would reject a client the spec allows.
 */
function isImplementation(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isString(value.name) || !isString(value.version)) return false;
  return (
    isOptional(value.title, isString) &&
    isOptional(value.description, isString) &&
    isOptional(value.websiteUrl, isString) &&
    isOptional(value.icons, (icons) => Array.isArray(icons) && icons.every(isIcon))
  );
}

/**
 * An `Icon` requires `src`; the rest are optional but typed when supplied. `src` is
 * checked as a string for the same reason as `name`/`version` — its `format: uri`
 * annotation is not something this server enforces, so rejecting `""` while accepting
 * any other non-URI string would be arbitrary.
 */
function isIcon(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (!isString(value.src)) return false;
  return (
    isOptional(value.mimeType, isString) &&
    isOptional(value.sizes, isStringArray) &&
    isOptional(value.theme, (theme) => theme === 'light' || theme === 'dark')
  );
}

function isOptional(value: unknown, check: (value: unknown) => boolean): boolean {
  return value === undefined || check(value);
}

function isString(value: unknown): boolean {
  return typeof value === 'string';
}

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every(isString);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
