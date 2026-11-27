import net from 'node:net';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { isLoopbackHostname } from './loopback-host.ts';

// The one rule for every request that carries a credential (a daemon or proxy token, a host bridge
// or provider bearer, a cloud auth secret): it travels over https, or over plain http only to this
// machine.

/** Why a client refuses to send a credential before any request leaves. */
const CREDENTIAL_TRANSPORT_REASONS = {
  // A credential would travel over plain http or ws to a host that is not loopback, to a socket URL
  // that is not ws or wss, or to a URL that does not parse. The refusal names the setting, never
  // the destination.
  insecureTransport: { reason: 'insecure_credential_transport' },
} as const satisfies ReasonTable<'remote connection'>;

/** The one plain-http destination off loopback a credential may name, and only when asked for. */
export type CredentialTransportExceptions = {
  /** The request goes to a device's CoreDevice tunnel address, which that tunnel encrypts. */
  coreDeviceTunnel?: boolean;
};

/** Whether a credential sent to `url` stays off the network in cleartext: https, or http on loopback. */
export function isSecureCredentialDestination(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

/** Plain http to a unique local IPv6 address in `fd00::/8`, where CoreDevice puts its tunnel. */
function isCoreDeviceTunnelDestination(url: URL): boolean {
  const address = url.hostname.replace(/^\[(.*)\]$/, '$1');
  const range = new net.BlockList();
  range.addSubnet('fd00::', 8, 'ipv6');
  return url.protocol === 'http:' && net.isIPv6(address) && range.check(address, 'ipv6');
}

/**
 * Refuses a credential-bearing destination unless it is https or plain http to loopback. A URL
 * that does not parse is refused too. `subject` names the setting in the message; the destination
 * itself is never named, so a refusal is safe on paths that must not disclose their endpoint.
 */
export function assertSecureCredentialTransport(
  url: string | URL,
  subject: string,
  exceptions: CredentialTransportExceptions = {},
): URL {
  const destination = typeof url === 'string' ? URL.parse(url) : url;
  if (destination) {
    if (isSecureCredentialDestination(destination)) return destination;
    if (exceptions.coreDeviceTunnel && isCoreDeviceTunnelDestination(destination)) {
      return destination;
    }
  }
  throw credentialTransportRefusal(
    destination
      ? `${subject} must use https to send credentials; plain http is allowed only on loopback.`
      : `${subject} is not a valid URL, so no credential is sent to it.`,
  );
}

/**
 * The same rule for a WebSocket that carries a credential: `wss` to any host, or `ws` to loopback.
 * Any other scheme is refused, including the http and https a `WebSocket` would accept.
 */
export function assertSecureCredentialSocket(url: string, subject: string): URL {
  const destination = URL.parse(url);
  if (destination?.protocol === 'wss:') return destination;
  if (destination?.protocol === 'ws:' && isLoopbackHostname(destination.hostname)) {
    return destination;
  }
  throw credentialTransportRefusal(
    `${subject} must use wss to send credentials; ws is allowed only on loopback.`,
  );
}

/** The typed refusal. It is only ever thrown before the credential leaves. */
function credentialTransportRefusal(message: string): AppError {
  return new AppError('INVALID_ARGS', message, {
    reason: CREDENTIAL_TRANSPORT_REASONS.insecureTransport.reason,
    dispatched: 'no',
    hint: 'Use an https or wss URL, or reach the host through a loopback tunnel or port forward, for example ssh -L 4310:127.0.0.1:4310 <host> and then http://127.0.0.1:4310.',
  });
}

export function isCredentialTransportRefusal(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    error.details?.reason === CREDENTIAL_TRANSPORT_REASONS.insecureTransport.reason
  );
}

const MAX_FOLLOWED_REDIRECTS = 3;

export function isRedirectStatus(status: number): boolean {
  return [301, 302, 303, 307, 308].includes(status);
}

export type CredentialFetch = {
  /** Names the setting a refusal is about. */
  subject: string;
  /** The caller's transport; global `fetch` by default. */
  send?: typeof fetch;
  /** For a download: also follows https to https on another origin, without the request headers. */
  followHttpsOffOrigin?: boolean;
};

/**
 * `fetch` for a request that carries a credential and may be redirected. Every URL it sends to
 * meets the credential transport rule. It follows up to three redirects itself, on the same origin,
 * keeping the method and body on a 307 or 308. Any other redirect is returned as the answer.
 */
export async function fetchWithCredential(
  url: string | URL,
  init: RequestInit,
  { subject, send = fetch, followHttpsOffOrigin = false }: CredentialFetch,
): Promise<Response> {
  let target = assertSecureCredentialTransport(url, subject);
  let request: RequestInit = { ...init, redirect: 'manual' };
  for (let followed = 0; ; followed += 1) {
    const response = await send(target.href, request);
    const next = followedTarget(response, target, followHttpsOffOrigin);
    if (!next || followed === MAX_FOLLOWED_REDIRECTS) return response;
    await response.body?.cancel().catch(() => undefined);
    request = redirectedRequest(request, response.status);
    if (next.origin !== target.origin) request = { ...request, headers: undefined };
    target = assertSecureCredentialTransport(next, subject);
  }
}

/** Where a redirect leads, when it is one `fetchWithCredential` follows. */
function followedTarget(response: Response, from: URL, offOrigin: boolean): URL | undefined {
  if (!isRedirectStatus(response.status)) return undefined;
  const location = response.headers.get('location');
  if (location === null) return undefined;
  const to = URL.parse(location, from);
  if (!to || to.username || to.password) return undefined;
  if (to.origin === from.origin) return to;
  return offOrigin && from.protocol === 'https:' && to.protocol === 'https:' ? to : undefined;
}

/** The request a followed redirect sends, with the change to GET that `fetch` makes. */
function redirectedRequest(request: RequestInit, status: number): RequestInit {
  const method = request.method?.toUpperCase() ?? 'GET';
  const becomesGet =
    status === 303 ? method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST';
  if (!becomesGet) return request;
  const headers = new Headers(request.headers);
  headers.delete('content-type');
  return { ...request, method: 'GET', body: undefined, headers };
}
