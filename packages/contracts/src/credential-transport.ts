import net from 'node:net';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { isLoopbackHostname } from './loopback-host.ts';

// The one rule for every request that carries a credential (a daemon or proxy token, a host bridge
// or provider bearer, a cloud auth secret): it travels over https, or over plain http only to this
// machine. `@agent-device/host-kit` applies it to every URL it sends a credential to.

/** Why a client refuses to send a credential before any request leaves. */
const CREDENTIAL_TRANSPORT_REASONS = {
  // A credential would travel over plain http or ws to a host that is not loopback, to a `localhost`
  // that resolves to no loopback address, to a socket URL that is not ws or wss, or to a URL that
  // does not parse. The refusal names the setting, never the destination.
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
export function credentialTransportRefusal(message: string): AppError {
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
