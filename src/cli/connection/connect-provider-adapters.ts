import type { CliFlags } from '@agent-device/contracts/command';
import type { ProviderConnectionVerification } from '@agent-device/contracts/remote';
import { verifyLimrunConnection } from '@agent-device/provider-limrun';
import { AppError } from '@agent-device/kernel/errors';
import { providerWebDriver } from '../../provider-webdriver.ts';
import { resolveRemoteConfigProfile } from '../../remote/remote-config.ts';
import { readVersion } from '@agent-device/host-kit/version';
import { type EnvMap } from '@agent-device/kernel/source-value';

import { resolveCloudConnectProfile } from './cloud-profile.ts';
import { resolveCloudWebDriverConnectProfile } from './cloud-webdriver-profile.ts';
import { resolveLimrunConnectProfile } from './limrun-profile.ts';
import { resolveProxyConnectProfile } from './proxy-profile.ts';
import { profileToCliFlags } from '../remote-config-flags.ts';
import { isConnectProviderName, type ConnectProvider } from './provider-policy.ts';

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

const CONNECT_PROVIDER_ADAPTERS = {
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
  browserstack: {
    resolve: (context) =>
      resolveCloudWebDriverConnectProfile({ provider: 'browserstack', ...context }),
    verify: verifyBrowserStack,
  },
  'aws-device-farm': {
    resolve: (context) =>
      resolveCloudWebDriverConnectProfile({ provider: 'aws-device-farm', ...context }),
    verify: verifyAwsDeviceFarm,
  },
  limrun: {
    resolve: resolveLimrunConnectProfile,
    verify: verifyLimrun,
  },
} satisfies Record<ConnectProvider, ConnectProviderAdapter>;

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
      ...(isConnectProviderName(leaseProvider) ? { provider: leaseProvider } : {}),
    };
  }
  const provider =
    options.provider ?? (shouldUseProxyConnectShortcut(options.flags) ? 'proxy' : 'cloud');
  const profile = await CONNECT_PROVIDER_ADAPTERS[provider].resolve({
    flags: options.flags,
    stateDir: options.stateDir,
    cwd,
    env,
  });
  return { ...profile, provider };
}

export async function verifyConnectProvider(options: {
  provider?: ConnectProvider;
  flags: CliFlags;
  env?: EnvMap;
}): Promise<ConnectVerification> {
  const env = options.env ?? process.env;
  if (!options.provider) {
    return {
      service: 'remote provider',
      status: 'configured',
      verificationMessage:
        'Remote connection profile loaded. Access is checked by the first remote command.',
    };
  }
  return await CONNECT_PROVIDER_ADAPTERS[options.provider].verify({
    flags: options.flags,
    env,
  });
}

async function verifyBrowserStack(
  context: Pick<AdapterContext, 'flags' | 'env'>,
): Promise<ConnectVerification> {
  const { flags, env } = context;
  return await providerWebDriver.verifyConnection({
    provider: 'browserstack',
    username: requiredResolvedValue(
      env.BROWSERSTACK_USERNAME,
      'BrowserStack profile missed BROWSERSTACK_USERNAME.',
    ),
    accessKey: requiredResolvedValue(
      env.BROWSERSTACK_ACCESS_KEY,
      'BrowserStack profile missed BROWSERSTACK_ACCESS_KEY.',
    ),
    platform: requiredResolvedPlatform(flags.platform, 'BrowserStack'),
    deviceName: requiredResolvedValue(flags.device, 'BrowserStack profile missed device.'),
    osVersion: requiredResolvedValue(
      flags.providerOsVersion,
      'BrowserStack profile missed OS version.',
    ),
    app: requiredResolvedValue(flags.providerApp, 'BrowserStack profile missed app.'),
  });
}

async function verifyAwsDeviceFarm(
  context: Pick<AdapterContext, 'flags' | 'env'>,
): Promise<ConnectVerification> {
  const { flags } = context;
  return await providerWebDriver.verifyConnection({
    provider: 'aws-device-farm',
    platform: requiredResolvedPlatform(flags.platform, 'AWS Device Farm'),
    projectArn: requiredResolvedValue(
      flags.awsProjectArn,
      'AWS Device Farm profile missed project ARN.',
    ),
    deviceArn: requiredResolvedValue(
      flags.awsDeviceArn,
      'AWS Device Farm profile missed device ARN.',
    ),
    appArn: flags.awsAppArn,
    region: flags.awsRegion,
  });
}

async function verifyLimrun(
  context: Pick<AdapterContext, 'flags' | 'env'>,
): Promise<ConnectVerification> {
  return await verifyLimrunConnection({
    apiKey: requiredResolvedValue(
      context.env.LIMRUN_API_KEY,
      'Limrun profile missed LIMRUN_API_KEY.',
    ),
    clientVersion: readVersion(),
    platform: requiredResolvedPlatform(context.flags.platform, 'Limrun'),
    region: context.env.LIMRUN_REGION?.trim() || undefined,
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

function requiredResolvedValue<T>(value: T | undefined, message: string): T {
  if (value !== undefined) return value;
  throw new AppError('COMMAND_FAILED', message, {
    hint: 'Reconnect to regenerate and validate the provider profile.',
  });
}

function requiredResolvedPlatform(
  platform: CliFlags['platform'],
  service: string,
): 'android' | 'ios' {
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('COMMAND_FAILED', `${service} profile missed a mobile platform.`, {
    hint: 'Reconnect with --platform ios|android.',
  });
}
