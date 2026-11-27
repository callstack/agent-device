import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import { isLoopbackHostname } from './loopback-host.ts';

// The one rule for every request that carries a credential (a daemon or proxy token, a host bridge
// or provider bearer, a cloud auth secret): it travels over https, or over plain http only to this
// machine. Callers check the final URL right before each send.

/** Why a client refuses to send a credential before any request leaves. */
const CREDENTIAL_TRANSPORT_REASONS = {
  // A credential would travel over plain http to a host that is not loopback, or to a URL that does
  // not parse. The refusal names the setting, never the destination.
  insecureTransport: { reason: 'insecure_credential_transport' },
} as const satisfies ReasonTable<'remote connection'>;

/** Whether a credential sent to `url` stays off the network in cleartext: https, or http on loopback. */
export function isSecureCredentialDestination(url: URL): boolean {
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && isLoopbackHostname(url.hostname);
}

/**
 * Refuses a credential-bearing destination unless it is https or plain http to loopback. A URL
 * that does not parse is refused too. `subject` names the setting in the message; the destination
 * itself is never named, so a refusal is safe on paths that must not disclose their endpoint.
 */
export function assertSecureCredentialTransport(url: string | URL, subject: string): URL {
  const destination = typeof url === 'string' ? URL.parse(url) : url;
  if (destination && isSecureCredentialDestination(destination)) return destination;
  throw new AppError(
    'INVALID_ARGS',
    destination
      ? `${subject} must use https to send credentials; plain http is allowed only on loopback.`
      : `${subject} is not a valid URL, so no credential is sent to it.`,
    {
      reason: CREDENTIAL_TRANSPORT_REASONS.insecureTransport.reason,
      hint: 'Use an https URL, or reach the host through a loopback tunnel or port forward, for example ssh -L 4310:127.0.0.1:4310 <host> and then http://127.0.0.1:4310.',
    },
  );
}
