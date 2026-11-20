import crypto from 'node:crypto';
import type { RemoteConfigProfile } from '@agent-device/contracts/remote';
import type { PluginConnection, PluginConnectionContext } from 'agent-device/plugins';
import {
  rejectRefusedProviderProfileFields,
  requireResolvedProfilePlatform,
} from '@agent-device/contracts/provider-profile-fields';
import { leaseBackendForPlatform } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import {
  LIMRUN_CREDENTIAL_REASONS,
  limrunInstanceVariables,
  readLimrunCredentials,
  requireLimrunCredentials,
} from './credentials.ts';
import {
  LIMRUN_CONNECTION_CAPABILITIES,
  LIMRUN_PROFILE_FIELDS,
  LIMRUN_PROVIDER,
  type LimrunPlatform,
} from './device.ts';

/** The flags and environment one `connect` call gives the provider. */
type ConnectContext = Pick<PluginConnectionContext, 'flags' | 'env' | 'stateDir'>;

/** The connection callbacks Limrun answers `agent-device connect limrun` with. */
export type LimrunConnection = Pick<PluginConnection, 'capabilities' | 'resolve' | 'verify'>;

/**
 * Limrun's `connect` callbacks: the one set both the built-in CLI composition and an installed
 * plugin answers with. `resolve` reads its own call's flags and environment and loads no SDK.
 * `verify` loads the provider's own verification only when it runs and asks the account or the
 * instance for a read only, so neither callback sets up a runtime, starts a daemon, or rents an
 * instance, and no caller names the verification entry from outside the provider.
 */
export function createLimrunConnection(): LimrunConnection {
  return {
    capabilities: LIMRUN_CONNECTION_CAPABILITIES,
    resolve: (context) => ({ profile: limrunConnectProfile(context) }),
    verify: async ({ flags, env, host }) =>
      await (
        await import('./connection-verification.ts')
      ).verifyLimrunConnection({
        ...requireLimrunCredentials(env),
        clientVersion: host.clientVersion,
        platform: requireResolvedProfilePlatform(flags.platform, 'Limrun'),
      }),
  };
}

/** The transport, lease and capture settings that Limrun adds to the saved profile. */
function limrunConnectProfile(context: ConnectContext): RemoteConfigProfile {
  const { flags, env, stateDir } = context;
  rejectRefusedProviderProfileFields(flags, LIMRUN_PROFILE_FIELDS);
  const leaseBackend = requireLimrunLeaseBackend(flags);
  const platform = leaseBackend === 'ios-instance' ? 'ios' : 'android';
  requireLimrunConnectAccess(env, platform);
  return {
    daemonTransport: 'auto',
    sessionIsolation: 'tenant',
    target: 'mobile',
    leaseBackend,
    leaseProvider: LIMRUN_PROVIDER,
    platform,
    // A Limrun lease is scoped by its run and its provider, and no device is picked before
    // allocation, so the provider names no client of its own and the host's identity stands.
    clientId: undefined,
    runId: flags.runId ?? limrunRunId(stateDir, flags.session ?? crypto.randomUUID()),
    // The capture opt-in is read at lease allocation, so it must survive into later commands.
    providerNetworkLogs: flags.providerNetworkLogs,
    providerNetworkHosts: flags.providerNetworkHosts,
  };
}

/** Keep the run identity of saved Limrun sessions so reconnect can reuse them. */
function limrunRunId(stateDir: string, session: string): string {
  const identity = [LIMRUN_PROVIDER, stateDir, session].join('\0');
  const digest = crypto.createHash('sha256').update(identity).digest('hex');
  return `${LIMRUN_PROVIDER}-${digest.slice(0, 16)}`;
}

/**
 * The one lease backend Limrun rents its platform on. `--platform` is what the caller selected: the
 * host's own lease defaults and a previous session's recorded platform are not this call's inputs.
 */
function requireLimrunLeaseBackend(
  flags: ConnectContext['flags'],
): 'android-instance' | 'ios-instance' {
  if (flags.platform !== 'android' && flags.platform !== 'ios') {
    throw new AppError('INVALID_ARGS', 'connect limrun requires --platform ios or android.');
  }
  if (flags.device !== undefined) {
    throw new AppError(
      'INVALID_ARGS',
      'connect limrun does not accept --device; Limrun selects a remote simulator or emulator.',
    );
  }
  const expected = flags.platform === 'ios' ? 'ios-instance' : 'android-instance';
  const leaseBackend = flags.leaseBackend ?? leaseBackendForPlatform(flags.platform);
  if (leaseBackend !== expected) {
    throw new AppError(
      'INVALID_ARGS',
      `connect limrun --platform ${flags.platform} requires --lease-backend ${expected}.`,
    );
  }
  return expected;
}

/**
 * The credentials one connect reaches: an account key, or the full instance set of the platform it
 * just resolved. Access to the other platform is not access to this one.
 */
function requireLimrunConnectAccess(env: ConnectContext['env'], platform: LimrunPlatform): void {
  const credentials = readLimrunCredentials(env);
  if (credentials?.apiKey || credentials?.instances?.[platform]) return;
  throw new AppError(
    'INVALID_ARGS',
    `connect limrun requires LIMRUN_API_KEY, or ${limrunInstanceVariables(platform).join(', ')} for an existing instance.`,
    {
      reason: LIMRUN_CREDENTIAL_REASONS.missing,
      hint: 'Set the credentials in the environment before running agent-device connect limrun.',
    },
  );
}
