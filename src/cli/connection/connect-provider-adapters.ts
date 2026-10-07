import type { CliFlags } from '@agent-device/contracts/command';
import { requireResolvedProfilePlatform } from '@agent-device/contracts/provider-profile-fields';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { verifyLimrunConnection } from '@agent-device/provider-limrun';
import { leaseBackendForPlatform } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { resolveRemoteConfigProfile } from '../../remote/remote-config.ts';
import { readVersion } from '@agent-device/host-kit/version';
import { type EnvMap } from '@agent-device/kernel/source-value';

import { resolveCloudConnectProfile } from './cloud-profile.ts';
import { resolveLimrunConnectProfile } from './limrun-profile.ts';
import { readLimrunCredentials } from '../../provider-limrun-credentials.ts';
import { resolveProxyConnectProfile } from './proxy-profile.ts';
import { profileToCliFlags } from '../remote-config-flags.ts';
import { isConnectProviderName, type ConnectProvider } from './provider-policy.ts';
import { bundledCloudWebDriverConnection } from '../../provider-webdriver.ts';
import { withPluginConnection } from '../../plugins/load.ts';
import type { PluginConnection } from '../../plugins/connection.ts';
import { readMetroProfileFields } from './profile-fields.ts';
import { buildConnectClientId } from './client-id.ts';
import { persistAndResolveGeneratedProfile } from './generated-config.ts';

type ConnectProfile = { flags: CliFlags; remoteConfigPath: string };
type ResolvedConnectProfile = ConnectProfile & { provider?: ConnectProvider };

export type ConfiguredConnectionVerification = {
  service: string;
  status: 'verified' | 'configured';
  verificationMessage: string;
  provider?: never;
  project?: never;
  device?: never;
  app?: never;
};

export type ConnectVerification = ProviderConnectionVerification | ConfiguredConnectionVerification;

type AdapterContext = {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env: EnvMap;
};

type ConnectProviderAdapter = {
  resolve(context: AdapterContext): Promise<ConnectProfile> | ConnectProfile;
  verify(context: Pick<AdapterContext, 'flags' | 'env'>): Promise<ConnectVerification>;
};

/** Providers whose profile the CLI composes itself; every other provider supplies connection callbacks. */
const CONNECT_PROVIDER_ADAPTERS: Readonly<
  Record<'cloud' | 'proxy' | 'limrun', ConnectProviderAdapter>
> = {
  cloud: {
    resolve: resolveCloudConnectProfile,
    verify: async () => ({
      service: 'the configured cloud service',
      status: 'verified',
      verificationMessage: 'Credentials and connection profile verified.',
    }),
  },
  proxy: {
    resolve: resolveProxyConnectProfile,
    verify: async () => ({
      service: 'Agent Device Proxy',
      status: 'configured',
      verificationMessage:
        'Proxy configuration saved. Access is checked by the first remote command.',
    }),
  },
  limrun: {
    resolve: resolveLimrunConnectProfile,
    verify: verifyLimrun,
  },
};

function builtinConnectAdapter(provider: string): ConnectProviderAdapter | undefined {
  return Object.hasOwn(CONNECT_PROVIDER_ADAPTERS, provider)
    ? CONNECT_PROVIDER_ADAPTERS[provider as keyof typeof CONNECT_PROVIDER_ADAPTERS]
    : undefined;
}

/** Runs a provider's connection callbacks: a bundled provider in-process, otherwise its installed plugin. */
async function withProviderConnection<T>(
  provider: string,
  env: EnvMap,
  run: (connection: PluginConnection) => Promise<T>,
): Promise<T> {
  const bundled = bundledCloudWebDriverConnection(provider, env);
  return bundled ? await run(bundled) : await withPluginConnection(provider, env, run);
}

export async function resolveConnectProviderProfile(options: {
  provider?: ConnectProvider;
  flags: CliFlags;
  stateDir: string;
  cwd?: string;
  env?: EnvMap;
}): Promise<ResolvedConnectProfile> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  if (options.flags.remoteConfig) {
    const resolved = resolveRemoteConfigProfile({
      configPath: options.flags.remoteConfig,
      cwd,
      env,
    });
    const leaseProvider = resolved.profile.leaseProvider;
    return {
      flags: {
        ...profileToCliFlags(resolved.profile),
        ...options.flags,
        remoteConfig: resolved.resolvedPath,
      },
      remoteConfigPath: resolved.resolvedPath,
      ...(isConnectProviderName(leaseProvider, env) ? { provider: leaseProvider } : {}),
    };
  }
  const provider =
    options.provider ?? (shouldUseProxyConnectShortcut(options.flags) ? 'proxy' : 'cloud');
  const context = {
    flags: options.flags,
    stateDir: options.stateDir,
    cwd,
    env,
  };
  const adapter = builtinConnectAdapter(provider);
  const profile = adapter
    ? await adapter.resolve(context)
    : await withProviderConnection(
        provider,
        env,
        async (connection) => await resolveProviderConnectionProfile(provider, connection, context),
      );
  return { ...profile, provider };
}

/**
 * The provider contributes its fields; the CLI adds identity, session defaults, Metro settings, and
 * the lease backend its platform rents on unless the provider or the caller named one.
 */
async function resolveProviderConnectionProfile(
  provider: string,
  connection: PluginConnection,
  context: AdapterContext,
): Promise<ConnectProfile> {
  const resolved = await connection.resolve(context);
  if (resolved.profile.leaseProvider !== provider)
    throw new AppError(
      'INVALID_ARGS',
      `Provider connection profile must select its declared provider: ${provider}`,
    );
  const clientId = buildConnectClientId(
    provider,
    context.stateDir,
    context.flags.session,
    resolved.profile.device,
  );
  return persistAndResolveGeneratedProfile({
    ...context,
    ...resolved,
    provider,
    profile: {
      tenant: context.flags.tenant ?? provider,
      sessionIsolation: context.flags.sessionIsolation ?? 'tenant',
      runId: context.flags.runId ?? `${provider}-${clientId}`,
      clientId,
      target: context.flags.target ?? 'mobile',
      session: context.flags.session,
      stateDir: context.stateDir,
      leaseBackend:
        context.flags.leaseBackend ?? leaseBackendForPlatform(resolved.profile.platform),
      ...readMetroProfileFields(context.flags),
      ...resolved.profile,
    },
  });
}

export async function verifyResolvedConnectProvider(
  resolved: ResolvedConnectProfile,
): Promise<ConnectVerification> {
  if (!resolved.provider) {
    return {
      service: 'remote provider',
      status: 'configured',
      verificationMessage:
        'Remote connection profile loaded. Access is checked by the first remote command.',
    };
  }
  const context = {
    flags: resolved.flags,
    env: process.env,
  };
  const adapter = builtinConnectAdapter(resolved.provider);
  return adapter
    ? await adapter.verify(context)
    : await withProviderConnection(
        resolved.provider,
        context.env,
        async (connection) => await connection.verify(context),
      );
}

async function verifyLimrun(
  context: Pick<AdapterContext, 'flags' | 'env'>,
): Promise<ConnectVerification> {
  return await verifyLimrunConnection({
    ...readLimrunCredentials(context.env),
    clientVersion: readVersion(),
    platform: requireResolvedProfilePlatform(context.flags.platform, 'Limrun'),
  });
}

function shouldUseProxyConnectShortcut(flags: CliFlags): boolean {
  if (!flags.daemonBaseUrl || flags.tenant || flags.runId || flags.leaseId || flags.leaseBackend) {
    return false;
  }
  try {
    const url = new URL(flags.daemonBaseUrl);
    return url.pathname.replace(/\/+$/, '').endsWith('/agent-device');
  } catch {
    return false;
  }
}
