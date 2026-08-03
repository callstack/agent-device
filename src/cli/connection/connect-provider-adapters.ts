import type { CliFlags } from '@agent-device/contracts/command';
import type { VerifiedProviderResource } from '@agent-device/provider-webdriver';
import { verifyLimrunConnection } from '@agent-device/provider-limrun';
import { providerWebDriver } from '../../provider-webdriver.ts';
import { resolveRemoteConfigProfile } from '../../remote/remote-config.ts';
import type { EnvMap } from '../../utils/env-map.ts';
import { readVersion } from '../../utils/version.ts';
import { resolveCloudConnectProfile } from './cloud-profile.ts';
import { resolveCloudWebDriverConnectProfile } from './cloud-webdriver-profile.ts';
import { resolveLimrunConnectProfile } from './limrun-profile.ts';
import { resolveProxyConnectProfile } from './proxy-profile.ts';
import { isConnectProviderName, type ConnectProvider } from './provider-policy.ts';

type ConnectProfile = { flags: CliFlags; remoteConfigPath: string };
type ResolvedConnectProfile = ConnectProfile & { provider?: ConnectProvider };

export type ConnectReadiness = {
  service: string;
  status: 'verified' | 'configured';
  message: string;
  project?: { name?: string; reference: string };
  device?: VerifiedProviderResource;
  app?: VerifiedProviderResource;
  nextSteps: string[];
  notes?: string[];
};

type AdapterContext = {
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env: EnvMap;
};

type ConnectProviderAdapter = {
  resolve(context: AdapterContext): Promise<ConnectProfile> | ConnectProfile;
  inspect(context: Pick<AdapterContext, 'flags' | 'env'>): Promise<ConnectReadiness>;
};

const CONNECT_PROVIDER_ADAPTERS = {
  cloud: {
    resolve: resolveCloudConnectProfile,
    inspect: async ({ flags }) => ({
      service: 'Agent Device Cloud',
      status: 'verified',
      message: 'Credentials and connection profile verified.',
      nextSteps: [openNextStep(flags.platform)],
    }),
  },
  proxy: {
    resolve: resolveProxyConnectProfile,
    inspect: async ({ flags }) => ({
      service: 'Agent Device Proxy',
      status: 'configured',
      message:
        'Proxy configuration saved. Run devices to inspect inventory without allocating; access is checked by the first remote command.',
      nextSteps: ['agent-device devices', openNextStep(flags.platform)],
    }),
  },
  browserstack: {
    resolve: (context) =>
      resolveCloudWebDriverConnectProfile({ provider: 'browserstack', ...context }),
    inspect: inspectBrowserStack,
  },
  'aws-device-farm': {
    resolve: (context) =>
      resolveCloudWebDriverConnectProfile({ provider: 'aws-device-farm', ...context }),
    inspect: inspectAwsDeviceFarm,
  },
  limrun: {
    resolve: resolveLimrunConnectProfile,
    inspect: inspectLimrun,
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
      flags: options.flags,
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

export async function inspectConnectProvider(options: {
  provider?: ConnectProvider;
  flags: CliFlags;
  env?: EnvMap;
}): Promise<ConnectReadiness> {
  const env = options.env ?? process.env;
  if (!options.provider) {
    return {
      service: 'remote provider',
      status: 'configured',
      message:
        'Remote connection profile loaded. Run a device command when ready; access is checked by the first remote command.',
      nextSteps: [openNextStep(options.flags.platform)],
    };
  }
  return await CONNECT_PROVIDER_ADAPTERS[options.provider].inspect({
    flags: options.flags,
    env,
  });
}

async function inspectBrowserStack(
  context: Pick<AdapterContext, 'flags' | 'env'>,
): Promise<ConnectReadiness> {
  const { flags, env } = context;
  const result = await providerWebDriver.verifyConnection({
    provider: 'browserstack',
    username: required(env.BROWSERSTACK_USERNAME),
    accessKey: required(env.BROWSERSTACK_ACCESS_KEY),
    platform: requiredPlatform(flags.platform),
    deviceName: required(flags.device),
    osVersion: required(flags.providerOsVersion),
    app: required(flags.providerApp),
  });
  return verifiedReadiness(result, {
    nextSteps: [openNextStep(result.device.platform)],
    notes: [
      'Use the installed package or bundle identifier in open, not the app artifact name.',
      'After close, run agent-device artifacts --json for provider video and logs.',
    ],
  });
}

async function inspectAwsDeviceFarm(
  context: Pick<AdapterContext, 'flags' | 'env'>,
): Promise<ConnectReadiness> {
  const { flags } = context;
  const result = await providerWebDriver.verifyConnection({
    provider: 'aws-device-farm',
    platform: requiredPlatform(flags.platform),
    projectArn: required(flags.awsProjectArn),
    deviceArn: required(flags.awsDeviceArn),
    appArn: flags.awsAppArn,
    region: flags.awsRegion,
  });
  if (result.provider !== 'aws-device-farm') {
    throw new Error('AWS Device Farm connect adapter received another provider result.');
  }
  const nextSteps =
    result.app.status === 'missing'
      ? [
          `agent-device connect aws-device-farm --platform ${result.device.platform} --aws-project-arn ${result.project.reference} --aws-device-arn ${result.device.reference} --aws-app-arn <arn> --force`,
          openNextStep(result.device.platform),
        ]
      : [openNextStep(result.device.platform)];
  return verifiedReadiness(result, {
    app: result.app.status === 'missing' ? { ...result.app, name: 'not attached' } : result.app,
    nextSteps,
    notes: [
      ...(result.app.status === 'missing'
        ? []
        : ['Use the installed package or bundle identifier in open, not the app artifact name.']),
      'After close, run agent-device artifacts --json for provider video and logs.',
    ],
  });
}

async function inspectLimrun(
  context: Pick<AdapterContext, 'flags' | 'env'>,
): Promise<ConnectReadiness> {
  const platform = requiredPlatform(context.flags.platform);
  const result = await verifyLimrunConnection({
    apiKey: required(context.env.LIMRUN_API_KEY),
    clientVersion: readVersion(),
    platform,
    region: context.env.LIMRUN_REGION?.trim() || undefined,
  });
  const appId = appIdPlaceholder(platform);
  return verifiedReadiness(result, {
    app: { ...result.app, name: 'not installed yet' },
    nextSteps: [
      `agent-device install ${appId} <app-path-or-url>`,
      `agent-device open ${appId} --relaunch`,
    ],
  });
}

function verifiedReadiness(
  verification: {
    service: string;
    verificationMessage: string;
    device: VerifiedProviderResource;
    app: VerifiedProviderResource;
    project?: { name?: string; reference: string };
  },
  workflow: Pick<ConnectReadiness, 'nextSteps' | 'notes'> & {
    app?: VerifiedProviderResource;
  },
): ConnectReadiness {
  return {
    service: verification.service,
    status: 'verified',
    message: verification.verificationMessage,
    ...(verification.project ? { project: verification.project } : {}),
    device: verification.device,
    app: workflow.app ?? verification.app,
    nextSteps: workflow.nextSteps,
    ...(workflow.notes ? { notes: workflow.notes } : {}),
  };
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

function openNextStep(platform: CliFlags['platform']): string {
  return `agent-device open ${appIdPlaceholder(platform)} --relaunch`;
}

function appIdPlaceholder(platform: CliFlags['platform']): string {
  return platform === 'ios' ? '<bundle-id>' : '<package-id>';
}

function required<T>(value: T | undefined): T {
  if (value !== undefined) return value;
  throw new Error('Connect provider profile resolution did not supply a required value.');
}

function requiredPlatform(platform: CliFlags['platform']): 'android' | 'ios' {
  if (platform === 'android' || platform === 'ios') return platform;
  throw new Error('Connect provider profile resolution did not supply a mobile platform.');
}
