import net from 'node:net';
import { isSecureCredentialDestination } from '@agent-device/contracts/credential-transport';
import { isLoopbackHostname } from '@agent-device/contracts/loopback-host';
import { AppError } from '@agent-device/kernel/errors';
import { normalizeBaseUrl } from '../metro/base-url.ts';

// Where the companion tunnel sends: the requests and sockets a bridge relays to the local dev server,
// and the sockets it opens itself.

/** The relayed request headers that carry a credential. */
const CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-agent-device-token',
];

/** The URL a relayed request goes to: a path on the local base's origin, and nothing else. */
export function relayTarget(localBaseUrl: string, requestPath: string): URL {
  const base = new URL(`${normalizeBaseUrl(localBaseUrl)}/`);
  const target = URL.parse(requestPath, base);
  if (URL.canParse(requestPath) || target?.origin !== base.origin) {
    throw new AppError(
      'INVALID_ARGS',
      'The Metro companion refuses a relayed path that leaves the local base URL.',
    );
  }
  return target;
}

/**
 * Sends one request the bridge relays to the local dev server. One that carries a credential, or
 * goes where a credential may, goes through `fetchWithCredential`: every URL checked, loopback
 * direct, redirects on the same origin only. Any other uses global `fetch`.
 */
export async function fetchRelayedRequest(target: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  const credentialed = CREDENTIAL_HEADERS.some((name) => headers.has(name));
  if (!credentialed && !isSecureCredentialDestination(target)) return await fetch(target, init);
  const { fetchWithCredential } = await import('@agent-device/host-kit/direct-http');
  return await fetchWithCredential(target, init, { subject: 'Metro companion local base URL' });
}

/**
 * Opens the companion's sockets. A plain socket to loopback connects directly, because the global
 * `WebSocket` hands its URL to an environment proxy, and to `localhost` only at a loopback address.
 * Every other socket is the global `WebSocket`.
 */
export async function createCompanionSocketDialer() {
  const [{ Agent, WebSocket: DirectWebSocket }, { lookupLoopbackOnly }] = await Promise.all([
    import('undici'),
    import('@agent-device/host-kit/direct-http'),
  ]);
  const agent = new Agent({ connect: { lookup: lookupLoopbackOnly } });
  const plainLoopback = (url: URL) =>
    (url.protocol === 'ws:' || url.protocol === 'http:') && isLoopbackHostname(url.hostname);
  return {
    /** Refuses a name that resolves off this machine here, where the refusal stays typed. */
    async verify(url: string): Promise<void> {
      const destination = new URL(url);
      const host = destination.hostname.replace(/^\[(.*)\]$/, '$1');
      if (!plainLoopback(destination) || net.isIP(host)) return;
      await new Promise<void>((resolve, reject) => {
        lookupLoopbackOnly(host, { all: true }, (error) => (error ? reject(error) : resolve()));
      });
    },
    open(url: string): WebSocket {
      if (!plainLoopback(new URL(url))) return new WebSocket(url);
      return new DirectWebSocket(url, { dispatcher: agent }) as unknown as WebSocket;
    },
    close: async (): Promise<void> => await agent.destroy(),
  };
}

export type CompanionSocketDialer = Awaited<ReturnType<typeof createCompanionSocketDialer>>;
