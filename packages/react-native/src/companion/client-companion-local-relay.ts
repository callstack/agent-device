import { fetchWithCredential } from '@agent-device/contracts/credential-transport';
import { AppError } from '@agent-device/kernel/errors';
import { normalizeBaseUrl } from '../metro/base-url.ts';

// Where the companion tunnel sends the requests and sockets a bridge relays to the local dev server.

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

/** Sends one relayed request. One that carries a credential meets the credential transport rule. */
export async function fetchRelayedRequest(target: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!CREDENTIAL_HEADERS.some((name) => headers.has(name))) return await fetch(target, init);
  return await fetchWithCredential(target, init, { subject: 'Metro companion local base URL' });
}
