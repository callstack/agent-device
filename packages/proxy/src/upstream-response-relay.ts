import {
  DAEMON_HTTP_BASE_PATH,
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
} from '@agent-device/contracts/daemon-http';

// Which upstream response headers a proxied response carries, the same on every route and
// transport. Loaded with the first forwarded response, never at module scope.

const FORWARDED_RESPONSE_HEADERS = [
  'content-type',
  'content-disposition',
  'x-request-id',
  DAEMON_HTTP_INSTANCE_MISMATCH_HEADER,
];
const FORWARDED_UPLOAD_CHUNK_RESPONSE_HEADERS = ['range', 'x-upload-offset'];
const FORWARDED_ARTIFACT_DOWNLOAD_RESPONSE_HEADERS = ['content-length'];

export type RelayedResponse = {
  upstreamResponse: Response;
  /** The URL the upstream request went to; a relative `Location` resolves against it. */
  upstreamUrl: URL;
  /** The client request's URL: its origin and base path are where a relayed target points. */
  requestUrl: string;
  requestId: string;
  route: string;
  upstreamBaseUrl: string;
  upstreamToken: string;
  publicOrigin: string | undefined;
};

/** The headers a proxied response carries: the allowlist, the request id, and a safe `Location`. */
export function relayedResponseHeaders(relay: RelayedResponse): Headers {
  const headers = new Headers();
  for (const name of [...FORWARDED_RESPONSE_HEADERS, ...routeResponseHeaders(relay.route)]) {
    const value = relay.upstreamResponse.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('x-request-id')) headers.set('x-request-id', relay.requestId);
  const location = relayedLocation(relay);
  if (location) headers.set('location', location);
  return headers;
}

/** `content-length` stays off the preflight route because the proxy rewrites that body. */
function routeResponseHeaders(route: string): readonly string[] {
  if (route.startsWith('/upload/direct/')) return FORWARDED_UPLOAD_CHUNK_RESPONSE_HEADERS;
  if (route.startsWith('/artifacts/')) return FORWARDED_ARTIFACT_DOWNLOAD_RESPONSE_HEADERS;
  return [];
}

/**
 * The `Location` of a relayed upstream 3xx, as the client must see it. Only a target on the
 * upstream daemon itself is relayed, as a path moved onto the client-facing origin and base path
 * the request came in on. Its query and fragment are dropped: the daemon redirects with neither,
 * and both can carry a credential. A target elsewhere, with userinfo, or whose path holds the
 * upstream token, as serialized or decoded, is dropped whole: the proxy never hands a client a
 * credential or a foreign destination.
 */
function relayedLocation(relay: RelayedResponse): string | undefined {
  const raw = relay.upstreamResponse.headers.get('location');
  if (!raw) return undefined;
  const target = URL.parse(raw, relay.upstreamUrl);
  const upstreamBase = new URL(relay.upstreamBaseUrl);
  if (!target || target.origin !== upstreamBase.origin || target.username || target.password) {
    return undefined;
  }
  const decoded = decodedPath(target);
  if (
    decoded === undefined ||
    [target.pathname, decoded].some((path) => path.includes(relay.upstreamToken))
  ) {
    return undefined;
  }
  const basePath = upstreamBase.pathname.replace(/\/+$/, '');
  if (basePath && target.pathname !== basePath && !target.pathname.startsWith(`${basePath}/`)) {
    return undefined;
  }
  const requestUrl = new URL(relay.requestUrl);
  const prefix = requestUrl.pathname.startsWith(`${DAEMON_HTTP_BASE_PATH}/`)
    ? DAEMON_HTTP_BASE_PATH
    : '';
  const relayed = new URL(relay.publicOrigin ?? requestUrl.origin);
  relayed.pathname = `${prefix}${target.pathname.slice(basePath.length) || '/'}`;
  return relayed.toString();
}

/** The path as the daemon would read it, or `undefined` for one with a malformed escape. */
function decodedPath(url: URL): string | undefined {
  try {
    return decodeURIComponent(url.pathname);
  } catch {
    return undefined;
  }
}
