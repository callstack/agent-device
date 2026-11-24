import type { CliFlags } from '@agent-device/contracts/command';
import type {
  ProviderConnectionResource,
  ProviderConnectionVerification,
} from '@agent-device/contracts/remote';
import { leaseBackendForPlatform } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { resolveRemoteConfigProfile } from '@agent-device/remote/remote-config';
import { type EnvMap, type HostEnvironment } from '@agent-device/kernel/source-value';

import { resolveProxyConnectProfile } from './proxy-profile.ts';
import { profileToCliFlags } from '../remote-config-flags.ts';
import {
  admitProviderForRoute,
  isConnectProviderName,
  providerRouteForConnection,
  type ConnectProvider,
} from './provider-policy.ts';
import { withPluginConnection } from '@agent-device/plugins/load';
import type { PluginConnectionCallbacks } from '@agent-device/plugins/connection';
import { readMetroProfileFields } from './profile-fields.ts';
import { buildConnectClientId } from './client-id.ts';
import { persistAndResolveGeneratedProfile, requireConnectionTarget } from './generated-config.ts';
import { cloudLimrunEnv } from './cloud-limrun.ts';
import type { CreatedCloudSession } from './cloud-session-api.ts';

type ConnectProfile = { flags: CliFlags; remoteConfigPath: string };
export type ResolvedConnectProfile = ConnectProfile & { provider?: ConnectProvider };

export type ConfiguredConnectionVerification = {
  service: string;
  status: 'verified' | 'configured';
  verificationMessage: string;
  provider?: never;
  project?: never;
  device?: never;
  app?: ProviderConnectionResource;
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

/**
 * The profiles the CLI composes itself: the routing identities answer with a saved connection's
 * settings, not a provider's callbacks. Every provider is an installed plugin and answers `resolve`
 * and `verify` through its connection callbacks.
 */
const CONNECT_PROVIDER_ADAPTERS: Readonly<Record<'proxy', ConnectProviderAdapter>> = {
  proxy: {
    resolve: resolveProxyConnectProfile,
    verify: async () => ({
      service: 'Agent Device Proxy',
      status: 'configured',
      verificationMessage:
        'Proxy configuration saved. Access is checked by the first remote command.',
    }),
  },
};

function builtinConnectAdapter(provider: string): ConnectProviderAdapter | undefined {
  return Object.hasOwn(CONNECT_PROVIDER_ADAPTERS, provider)
    ? CONNECT_PROVIDER_ADAPTERS[provider as keyof typeof CONNECT_PROVIDER_ADAPTERS]
    : undefined;
}

/** The connection callbacks one `connect` call runs: an installed plugin's, through the registry. */
async function providerConnection(
  provider: string,
  host: HostEnvironment,
): Promise<PluginConnectionCallbacks> {
  return await withPluginConnection(provider, [], host.env, async (connection) => connection);
}

export function selectCloudSessionPath(
  provider: ConnectProvider | undefined,
  flags: CliFlags,
): boolean {
  const cloud =
    provider === 'cloud' ||
    (!provider &&
      !flags.remoteConfig &&
      !shouldUseProxyConnectShortcut(flags) &&
      !flags.daemonBaseUrl);
  if (
    !cloud &&
    (flags.vendor !== undefined ||
      flags.maxMinutes !== undefined ||
      flags.maxUsd !== undefined ||
      flags.needs !== undefined ||
      flags.showViewer)
  ) {
    throw new AppError(
      'INVALID_ARGS',
      '--vendor, --max-minutes, --max-usd, --needs and --show-viewer require connect cloud.',
    );
  }
  return cloud;
}

export async function resolveCloudSessionProfile(
  context: AdapterContext,
  session: CreatedCloudSession,
): Promise<ResolvedConnectProfile> {
  const { binding, attachment } = session;
  const clientId = buildConnectClientId('cloud', binding.baseUrl, binding.id);
  const flags = {
    ...context.flags,
    daemonBaseUrl: undefined,
    daemonAuthToken: undefined,
    daemonServerMode: undefined,
    leaseId: undefined,
    leaseBackend: undefined,
    tenant: 'cloud',
    runId: `cloud-${clientId}`,
    target: 'mobile' as const,
  };
  const profile =
    attachment.kind === 'limrun'
      ? (
          await (
            await providerConnection('limrun', context)
          ).resolve({
            ...context,
            flags: { ...flags, device: undefined },
            env: { ...context.env, ...cloudLimrunEnv(attachment) },
          })
        ).profile
      : {
          tenant: flags.tenant,
          runId: flags.runId,
          session: flags.session,
          platform: flags.platform,
          target: flags.target,
        };
  return {
    ...persistAndResolveGeneratedProfile({
      ...context,
      flags,
      provider: 'cloud',
      profile: { ...profile, clientId },
    }),
    provider: 'cloud',
  };
}

export async function resolveConnectProviderProfile(options: {
  provider?: ConnectProvider;
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env: EnvMap;
}): Promise<ResolvedConnectProfile> {
  const { cwd, env } = options;
  if (options.flags.remoteConfig) {
    const resolved = resolveRemoteConfigProfile({
      configPath: options.flags.remoteConfig,
      cwd,
      env,
    });
    requireConnectionTarget(options.flags, resolved.profile.target);
    const leaseProvider = resolved.profile.leaseProvider;
    const flags = {
      ...profileToCliFlags(resolved.profile),
      ...options.flags,
      remoteConfig: resolved.resolvedPath,
    };
    const route = providerRouteForConnection({ daemonBaseUrl: flags.daemonBaseUrl, env });
    if (leaseProvider === 'cloud' && route === 'drives-connection') {
      throw new AppError(
        'INVALID_ARGS',
        'Use connect cloud --platform ios or android to allocate a hosted session.',
      );
    }
    await admitProviderForRoute(leaseProvider, route, env);
    const provider =
      isConnectProviderName(leaseProvider, env) &&
      (route === 'drives-connection' || builtinConnectAdapter(leaseProvider))
        ? leaseProvider
        : undefined;
    return { flags, remoteConfigPath: resolved.resolvedPath, provider };
  }
  const context = { flags: options.flags, stateDir: options.stateDir, cwd, env };
  const provider =
    options.provider ?? (shouldUseProxyConnectShortcut(options.flags) ? 'proxy' : undefined);
  if (!provider && options.flags.daemonBaseUrl)
    return resolveConfiguredDaemon(context, options.flags.daemonBaseUrl);
  if (!provider)
    throw new AppError('INVALID_ARGS', 'Use connect cloud or supply a daemon endpoint.');
  const adapter = builtinConnectAdapter(provider);
  const profile = adapter
    ? await adapter.resolve(context)
    : await resolveProviderConnectionProfile(
        provider,
        await providerConnection(provider, { env, cwd }),
        context,
      );
  return { ...profile, provider };
}

function resolveConfiguredDaemon(context: AdapterContext, daemonBaseUrl: string): ConnectProfile {
  const { flags } = context;
  const clientId = buildConnectClientId(context.stateDir, daemonBaseUrl, flags.session);
  return persistAndResolveGeneratedProfile({
    ...context,
    provider: 'daemon',
    profile: {
      daemonBaseUrl,
      daemonTransport: flags.daemonTransport ?? 'http',
      daemonServerMode: flags.daemonServerMode,
      tenant: flags.tenant ?? 'daemon',
      runId: flags.runId ?? `daemon-${clientId}`,
      leaseId: flags.leaseId,
      leaseBackend: flags.leaseBackend,
      sessionIsolation: flags.sessionIsolation,
      platform: flags.platform,
      target: flags.target,
      session: flags.session,
      clientId,
      ...readMetroProfileFields(flags),
    },
  });
}

/**
 * The provider contributes its fields; the CLI adds identity, session defaults, Metro settings, and
 * the lease backend its platform rents on unless the provider or the caller named one.
 */
async function resolveProviderConnectionProfile(
  provider: string,
  connection: PluginConnectionCallbacks,
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
      target: 'mobile',
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
  host: HostEnvironment,
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
    env: host.env,
    cwd: host.cwd,
  };
  const adapter = builtinConnectAdapter(resolved.provider);
  if (adapter) return await adapter.verify(context);
  const connection = await providerConnection(resolved.provider, host);
  return await connection.verify(context);
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
