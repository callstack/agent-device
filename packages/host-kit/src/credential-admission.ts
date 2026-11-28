import { credentialTransportRefusal } from '@agent-device/contracts/credential-transport';
import { escapeTerminalText } from '@agent-device/kernel/redaction';
import type { EnvMap } from '@agent-device/kernel/source-value';

const warnedOrigins = new Set<string>();

/**
 * The one warn-or-refuse decision for a configured URL that receives a first-party credential.
 * 0.21.x warns on stderr, once per origin per process. 0.22 throws the refusal instead.
 */
export function admitCredentialDestination(url: string, env: Readonly<EnvMap>): void {
  const refusal = credentialTransportRefusal(url, env);
  if (!refusal) return;
  const origin = String(refusal.details?.origin);
  if (warnedOrigins.has(origin)) return;
  warnedOrigins.add(origin);
  process.stderr.write(
    escapeTerminalText(
      `Warning: credentials for ${origin} are sent in cleartext. agent-device 0.22 will refuse this. ` +
        'Use https, ssh -L, or Tailscale Serve, or set AGENT_DEVICE_ALLOW_INSECURE_TRANSPORT=1.\n',
    ),
  );
}
