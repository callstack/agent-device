import type { CliFlags } from '@agent-device/contracts/command';
import type { RemoteConnectionRequestMetadata } from '@agent-device/remote/remote-connection-state';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { connectionLeaseProvider, primeProviderConnection } from './provider-policy.ts';

type AdmissionContext = Readonly<{
  host: HostEnvironment;
  command: string;
  positionals: readonly string[];
  flags: CliFlags;
  /** The lease provider an explicit remote config profile names. */
  remoteConfigLeaseProvider: string | undefined;
  connectionDefaults: { connection?: RemoteConnectionRequestMetadata } | null;
  /** Whether the command materializes its remote connection. Cleanup commands do not. */
  materializes: boolean;
}>;

/**
 * Admits the provider `connect` or a materializing command is about to use, before remote
 * authentication runs: a missing plugin refuses with its install command, so no login starts and no
 * auth state is written. Cleanup commands admit no provider, so they work after a plugin is removed.
 */
export async function admitConnectionProvider(context: AdmissionContext): Promise<void> {
  const provider = connectionProviderToAdmit(context);
  if (provider !== undefined) await primeProviderConnection(provider, context.host.env);
}

function connectionProviderToAdmit(context: AdmissionContext): string | undefined {
  if (context.command === 'connect') {
    // `connect <provider>` names it; `connect --remote-config` reads it from the profile.
    return (
      context.remoteConfigLeaseProvider ??
      (context.flags.remoteConfig ? undefined : context.positionals[0])
    );
  }
  if (!context.materializes) return undefined;
  return connectionLeaseProvider(
    context.connectionDefaults?.connection,
    context.remoteConfigLeaseProvider,
  );
}
