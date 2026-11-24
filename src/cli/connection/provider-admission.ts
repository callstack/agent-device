import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { AppError } from '@agent-device/kernel/errors';
import { canonicalLeaseProvider } from '@agent-device/kernel/contracts';
import { parseRawArgs } from '../parser/args.ts';
import {
  admitProviderForRoute,
  isConnectProviderName,
  primeProviderConnection,
  providerRouteForConnection,
  requiresOwnProviderAdmission,
} from './provider-policy.ts';

/** Resolves the catalog before normal connection options or daemon credentials are read. */
export async function preflightConnect(
  argv: readonly string[],
  host: HostEnvironment,
): Promise<ReturnType<typeof parseRawArgs> | undefined> {
  const parsed = rawConnectArgs(argv);
  if (!parsed) return;
  const [first, second] = parsed.positionals;
  const provider = canonicalLeaseProvider(first);
  if (provider === 'cloud' && second === 'list') return parsed;
  if (provider === 'list') {
    await primeProviderConnection(provider, host.env);
    if (!isConnectProviderName(provider, host.env)) return parsed;
  }
  if (parsed.providedFlags.some(({ key }) => key === 'live')) {
    throw new AppError(
      'INVALID_ARGS',
      '--live requires a catalog listing. Use connect cloud list.',
    );
  }
  if (
    !parsed.flags.remoteConfig &&
    parsed.positionals.length <= 1 &&
    requiresOwnProviderAdmission(provider)
  ) {
    await primeProviderConnection(provider, host.env);
  }
}

function rawConnectArgs(argv: readonly string[]): ReturnType<typeof parseRawArgs> | undefined {
  try {
    const parsed = parseRawArgs([...argv]);
    if (parsed.command === 'connect' && !parsed.flags.help && !parsed.flags.version) return parsed;
  } catch {
    // The ordinary parser reports its own diagnostic.
  }
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
