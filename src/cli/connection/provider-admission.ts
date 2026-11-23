import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { canonicalLeaseProvider } from '@agent-device/kernel/contracts';
import { parseRawArgs } from '../parser/args.ts';
import {
  admitProviderForRoute,
  primeProviderConnection,
  providerRouteForConnection,
  requiresOwnProviderAdmission,
} from './provider-policy.ts';

/** Admits a provider named as a connect positional before credential handling. */
export async function admitConnectProviderNamedInArguments(
  argv: readonly string[],
  host: HostEnvironment,
): Promise<void> {
  const provider = connectProviderNamedInArguments(argv);
  if (!requiresOwnProviderAdmission(provider)) return;
  await primeProviderConnection(provider, host.env);
}

function connectProviderNamedInArguments(argv: readonly string[]): string | undefined {
  let parsed: ReturnType<typeof parseRawArgs>;
  try {
    parsed = parseRawArgs([...argv]);
  } catch {
    // A command line the parser refuses is answered by the ordinary parse, with its own diagnostic.
    return undefined;
  }
  if (parsed.command !== 'connect') return undefined;
  // Help and version answer from the command line alone and load no plugin.
  if (parsed.flags.help || parsed.flags.version) return undefined;
  if (parsed.flags.remoteConfig || parsed.positionals.length > 1) return undefined;
  return canonicalLeaseProvider(parsed.positionals[0]);
}

export async function admitConnectProfileProvider(
  provider: string | undefined,
  daemonBaseUrl: string | undefined,
  host: HostEnvironment,
): Promise<void> {
  if (!requiresOwnProviderAdmission(provider)) return;
  await admitProviderForRoute(
    provider,
    providerRouteForConnection({ daemonBaseUrl, env: host.env }),
    host.env,
  );
}
