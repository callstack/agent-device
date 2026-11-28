import { Console } from 'node:console';
import { credentialTransportRefusal } from '@agent-device/contracts/credential-transport';
import { escapeTerminalText } from '@agent-device/kernel/redaction';
import type { EnvMap } from '@agent-device/kernel/source-value';

const warnedOrigins = new Set<string>();
// Node's Console ignores stream errors (sync throws and async EPIPE) without keeping listeners, so
// the optional warning never changes what the command does.
let warningConsole: Console | undefined;

/**
 * The one warn-or-refuse decision for a configured URL that receives a first-party credential.
 * 0.21.x warns on stderr, once per origin per loaded package: each published bundle holds its own
 * copy of this module. 0.22 throws the refusal instead.
 */
export function admitCredentialDestination(
  url: string,
  env: Readonly<EnvMap>,
  hint?: string,
): void {
  const refusal = credentialTransportRefusal(url, env, hint);
  if (!refusal) return;
  const origin = String(refusal.details?.origin);
  if (warnedOrigins.has(origin)) return;
  warnedOrigins.add(origin);
  warningConsole ??= new Console({ stdout: process.stderr, stderr: process.stderr });
  warningConsole.error(
    escapeTerminalText(
      `Warning: credentials for ${origin} are sent in cleartext. agent-device 0.22 will refuse this. ` +
        String(refusal.details?.hint),
    ),
  );
}
