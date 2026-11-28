import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { EnvMap } from '@agent-device/kernel/source-value';
import { isLoopbackHostname } from './loopback-host.ts';

const CREDENTIAL_TRANSPORT_REASONS = {
  // A first-party credential would go to a configured URL that is neither https nor plain http to a
  // loopback host, and AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT is not 1. agent-device 0.21.x warns on
  // stderr instead of failing with it; 0.22 refuses with it before sending anything.
  insecureTransport: { reason: 'insecure_credential_transport' },
} as const satisfies ReasonTable<'remote connection'>;

/**
 * The rule for a configured URL that receives a first-party credential: https, or plain http to a
 * loopback host. Returns the refusal for any other URL, unless the operator set
 * `AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT=1`. The refusal names the origin only.
 *
 * `env` is the sending process's own environment, never a value from a profile, ticket or peer.
 */
export function credentialTransportRefusal(
  url: string,
  env: Readonly<EnvMap>,
): AppError | undefined {
  if (env.AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT === '1') return undefined;
  const destination = URL.parse(url);
  if (destination?.protocol === 'https:') return undefined;
  if (destination?.protocol === 'http:' && isLoopbackHostname(destination.hostname)) {
    return undefined;
  }
  const origin = destination?.origin ?? 'an invalid URL';
  return new AppError('INVALID_ARGS', `Refusing to send a credential in cleartext to ${origin}.`, {
    reason: CREDENTIAL_TRANSPORT_REASONS.insecureTransport.reason,
    origin,
    hint: 'Use https, ssh -L, or Tailscale Serve, or set AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT=1.',
  });
}
