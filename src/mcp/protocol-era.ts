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
 * A request is modern exactly when it declares a protocol version in `_meta`. Legacy
 * responses stay byte-identical to what earlier releases sent, so upgrading a client is
 * the only thing that changes wire shape.
 */
export type ProtocolEra = 'legacy' | 'modern';

/** Newest revision we implement. Requests declaring it are served statelessly. */
export const MODERN_PROTOCOL_VERSION = '2026-07-28';

/**
 * Answer for legacy clients whose requested revision we do not implement. The
 * `initialize` contract is "echo the requested version, or name one you do support".
 */
export const PREFERRED_LEGACY_PROTOCOL_VERSION = '2025-11-25';

/**
 * Revisions we implement, newest first — the list a client may choose from.
 *
 * Scoped to what this server actually provides rather than every published revision:
 * a tools-only server's surface (`tools/list`, `tools/call`, `outputSchema`,
 * `structuredContent`) is identical across `2026-07-28`, `2025-11-25`, and `2025-06-18`.
 * Revisions before `2025-06-18` predate `outputSchema`/`structuredContent`, which every
 * typed tool here returns, so they are not claimed.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = [
  MODERN_PROTOCOL_VERSION,
  PREFERRED_LEGACY_PROTOCOL_VERSION,
  '2025-06-18',
];

/** JSON-RPC error code for a declared revision this server does not implement. */
export const UNSUPPORTED_PROTOCOL_VERSION_CODE = -32022;

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
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
 * Classifies one request and rejects revisions we do not implement.
 *
 * `server/discover` is a modern-only probe, so it stays modern even when a client omits
 * `_meta`: a legacy client has no reason to call it, and answering a `DiscoverResult`
 * without `resultType` would misreport this server's era.
 */
export function resolveProtocolEra(method: string, params: unknown): ProtocolEra {
  const declared = declaredProtocolVersion(params);
  if (declared !== undefined && !SUPPORTED_PROTOCOL_VERSIONS.includes(declared)) {
    throw new UnsupportedProtocolVersionError(declared);
  }
  if (declared !== undefined) return 'modern';
  return method === 'server/discover' ? 'modern' : 'legacy';
}

/**
 * Legacy `initialize` version negotiation: echo the client's revision when we implement
 * it, otherwise name the newest legacy revision we do. Answering with an unrequested
 * version tells a pinned client to disconnect, so the echo is the interoperable branch.
 */
export function negotiateLegacyProtocolVersion(params: unknown): string {
  const requested = stringField(asRecord(params), 'protocolVersion');
  if (requested !== undefined && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return PREFERRED_LEGACY_PROTOCOL_VERSION;
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

function declaredProtocolVersion(params: unknown): string | undefined {
  const meta = asRecord(asRecord(params)._meta);
  return stringField(meta, PROTOCOL_VERSION_META_KEY);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
