import { assertSecureCredentialTransport } from '@agent-device/contracts/credential-transport';
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

/** The URL a relayed request goes to: its path resolved on the local base, on that origin only. */
export function relayTarget(localBaseUrl: string, requestPath: string): URL {
  const base = new URL(`${normalizeBaseUrl(localBaseUrl)}/`);
  const target = URL.parse(requestPath, base);
  if (!target || target.origin !== base.origin) {
    throw new AppError(
      'INVALID_ARGS',
      'The Metro companion refuses a relayed path that leaves the local base URL.',
    );
  }
  return target;
}

/**
 * Sends one relayed request. One that carries a known credential header meets the credential
 * transport rule. A redirect goes back to the bridge as the answer: `fetch` would resend any
 * custom header to another origin, and the relay cannot tell which ones are secret.
 */
export async function fetchRelayedRequest(target: URL, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers);
  if (CREDENTIAL_HEADERS.some((name) => headers.has(name))) {
    assertSecureCredentialTransport(target, 'Metro companion local base URL');
  }
  return await fetch(target, { ...init, redirect: 'manual' });
}
