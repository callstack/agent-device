import type { CliFlags } from '@agent-device/contracts/command';
import type { RemoteConnectionRequestMetadata } from '@agent-device/remote/remote-connection-state';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { CLOUD_LEASE_PROVIDER } from '@agent-device/contracts/lease-scope';
import { readRemoteConfigFile } from '@agent-device/remote/remote-config-core';
import { parseRawArgs } from '../parser/args.ts';
import {
  connectionLeaseProvider,
  primeProviderConnection,
  requiresOwnProviderAdmission,
  usesProxyConnectShortcut,
} from './provider-policy.ts';

type AdmissionContext = Readonly<{
  host: HostEnvironment;
  command: string;
  flags: CliFlags;
  /** The lease provider an explicit remote config profile names. */
  remoteConfigLeaseProvider: string | undefined;
  connectionDefaults: { connection?: RemoteConnectionRequestMetadata } | null;
  /** Whether the command materializes its remote connection. Cleanup commands do not. */
  materializes: boolean;
}>;

/**
 * Admits the provider a materializing command is about to attach to, before that command
 * authenticates: a provider whose plugin cannot supply it refuses with its install or repair
 * guidance, so no login starts and no auth state is written. Cleanup commands admit no provider, so
 * they work after a plugin is removed. `connect` admits its own provider earlier, where it names it.
 */
export async function admitConnectionProvider(context: AdmissionContext): Promise<void> {
  if (!context.materializes) return;
  const provider = connectionLeaseProvider(
    context.connectionDefaults?.connection,
    context.remoteConfigLeaseProvider,
  );
  if (requiresOwnProviderAdmission(provider)) {
    await primeProviderConnection(provider, context.host.env);
  }
}

/**
 * Admits the provider `connect` names in its own arguments: its positional, or the provider its
 * explicit profile file declares. The CLI calls this before it resolves any option that can carry a
 * credential, so a route that cannot supply that provider refuses without reading or registering one.
 * The command line and that file are read directly, with no flag, config, or environment defaults.
 * An arity violation, such as two positionals, is left to the ordinary parse.
 */
export async function admitConnectProviderNamedInArguments(
  argv: readonly string[],
  host: HostEnvironment,
): Promise<void> {
  const provider = connectProviderNamedInArguments(argv, host);
  if (!requiresOwnProviderAdmission(provider)) return;
  await primeProviderConnection(provider, host.env);
}

/**
 * Whether `connect` holds a login it approves until the provider it discovers is admitted.
 *
 * Only the route that reads its profile from the cloud control plane learns its provider after it
 * authenticates, and so is the one that can approve a login that provider then refuses. A `connect`
 * that names a provider, or passes an explicit profile, admits that provider before it authenticates,
 * so neither can hold a refused login.
 */
export function defersConnectLogin(context: {
  command: string;
  flags: CliFlags;
  positionals: readonly string[];
}): boolean {
  if (context.command !== 'connect') return false;
  const namedProvider = context.positionals[0];
  if (namedProvider !== undefined) return namedProvider === CLOUD_LEASE_PROVIDER;
  if (context.flags.remoteConfig !== undefined) return false;
  // A daemon whose URL is its own proxy endpoint is connected directly, without a profile.
  return !usesProxyConnectShortcut(context.flags);
}

function connectProviderNamedInArguments(
  argv: readonly string[],
  host: HostEnvironment,
): string | undefined {
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
  const profilePath = parsed.flags.remoteConfig;
  if (typeof profilePath === 'string') return providerOfProfileFile(profilePath, host);
  return parsed.positionals[0];
}

/** The provider an explicit profile file declares, or undefined when it cannot be read yet. */
function providerOfProfileFile(configPath: string, host: HostEnvironment): string | undefined {
  try {
    // `readRemoteConfigFile`, not the env-merged resolver: only what the file itself declares is read.
    const { profile } = readRemoteConfigFile({ configPath, cwd: host.cwd, env: host.env });
    return profile.leaseProvider;
  } catch {
    // An unreadable profile is answered by the ordinary read of it, which names the file.
    return undefined;
  }
}
