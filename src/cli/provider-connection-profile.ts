import crypto from 'node:crypto';
import { CLOUD_WEBDRIVER_PROVIDERS } from '../cloud-webdriver/providers.ts';
import type { CloudWebDriverKnownProviderName } from '../cloud-webdriver/providers.ts';
import type { RemoteConfigProfile } from '../remote-config-schema.ts';
import { AppError } from '../kernel/errors.ts';
import type { PlatformSelector } from '../kernel/device.ts';
import type { CliFlags } from '../utils/cli-flags.ts';
import type { EnvMap } from '../utils/env-map.ts';
import { persistAndResolveGeneratedProfile } from './generated-remote-config.ts';
import { resolveRequestedLeaseBackend } from './commands/connection-runtime.ts';

export function resolveCloudWebDriverConnectProfile(options: {
  provider: CloudWebDriverKnownProviderName;
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const providerConfig = requireConnectProfileBuilder(options.provider)(options);
  const clientId = buildCloudWebDriverClientId(
    options.provider,
    options.stateDir,
    options.flags.session,
    providerConfig.device,
  );
  const profile: RemoteConfigProfile = {
    tenant: options.flags.tenant ?? options.provider,
    sessionIsolation: options.flags.sessionIsolation ?? 'tenant',
    runId: options.flags.runId ?? `${options.provider}-${clientId}`,
    leaseProvider: options.provider,
    clientId,
    leaseBackend: options.flags.leaseBackend ?? resolveRequestedLeaseBackend(options.flags),
    target: options.flags.target ?? 'mobile',
    session: options.flags.session,
    ...providerConfig,
    metroProjectRoot: options.flags.metroProjectRoot,
    metroKind: options.flags.metroKind,
    metroPublicBaseUrl: options.flags.metroPublicBaseUrl,
    metroProxyBaseUrl: options.flags.metroProxyBaseUrl,
    metroPreparePort: options.flags.metroPreparePort,
    metroListenHost: options.flags.metroListenHost,
    metroStatusHost: options.flags.metroStatusHost,
    metroStartupTimeoutMs: options.flags.metroStartupTimeoutMs,
    metroProbeTimeoutMs: options.flags.metroProbeTimeoutMs,
    metroRuntimeFile: options.flags.metroRuntimeFile,
    metroNoReuseExisting: options.flags.metroNoReuseExisting,
    metroNoInstallDeps: options.flags.metroNoInstallDeps,
  };
  return persistAndResolveGeneratedProfile({
    stateDir: options.stateDir,
    provider: options.provider,
    profile,
    cwd: options.cwd,
    env: options.env,
    flags: options.flags,
  });
}

type ConnectProfileBuilder = (options: { flags: CliFlags; env?: EnvMap }) => RemoteConfigProfile;

const CLOUD_WEBDRIVER_CONNECT_PROFILE_BUILDERS: readonly {
  provider: CloudWebDriverKnownProviderName;
  buildProfileFields: ConnectProfileBuilder;
}[] = [
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    buildProfileFields: browserStackProfileFields,
  },
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    buildProfileFields: awsDeviceFarmProfileFields,
  },
];

function requireConnectProfileBuilder(
  provider: CloudWebDriverKnownProviderName,
): ConnectProfileBuilder {
  const builder = CLOUD_WEBDRIVER_CONNECT_PROFILE_BUILDERS.find(
    (entry) => entry.provider === provider,
  )?.buildProfileFields;
  if (builder) return builder;
  throw new AppError('INVALID_ARGS', `Unsupported cloud WebDriver provider "${provider}".`);
}

function browserStackProfileFields(options: {
  flags: CliFlags;
  env?: EnvMap;
}): RemoteConfigProfile {
  requireEnv(options.env, 'BROWSERSTACK_USERNAME', 'connect browserstack');
  requireEnv(options.env, 'BROWSERSTACK_ACCESS_KEY', 'connect browserstack');
  const platform = requireCloudWebDriverPlatform(
    options.flags.platform,
    'connect browserstack requires --platform ios|android.',
  );
  const device = requireFlag(
    options.flags.device,
    'connect browserstack requires --device <name>.',
  );
  const providerOsVersion = requireFlag(
    options.flags.providerOsVersion,
    'connect browserstack requires --provider-os-version <version>.',
  );
  const providerApp = requireFlag(
    options.flags.providerApp,
    'connect browserstack requires --provider-app <bs://app-id-or-local-path>.',
  );
  return {
    platform,
    device,
    providerOsVersion,
    providerApp,
    providerProject: options.flags.providerProject,
    providerBuild: options.flags.providerBuild,
    providerSessionName: options.flags.providerSessionName,
  };
}

function awsDeviceFarmProfileFields(options: {
  flags: CliFlags;
  env?: EnvMap;
}): RemoteConfigProfile {
  const platform = requireCloudWebDriverPlatform(
    options.flags.platform,
    'connect aws-device-farm requires --platform ios|android.',
  );
  return {
    platform,
    device: options.flags.device,
    awsProjectArn: requireFlag(
      options.flags.awsProjectArn ??
        options.env?.AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN ??
        options.env?.AWS_DEVICE_FARM_PROJECT_ARN,
      'connect aws-device-farm requires --aws-project-arn <arn> or AWS_DEVICE_FARM_PROJECT_ARN.',
    ),
    awsDeviceArn: requireFlag(
      options.flags.awsDeviceArn ??
        options.env?.AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN ??
        options.env?.AWS_DEVICE_FARM_DEVICE_ARN,
      'connect aws-device-farm requires --aws-device-arn <arn> or AWS_DEVICE_FARM_DEVICE_ARN.',
    ),
    awsAppArn:
      options.flags.awsAppArn ??
      options.env?.AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN ??
      options.env?.AWS_DEVICE_FARM_APP_ARN,
    awsRegion:
      options.flags.awsRegion ?? options.env?.AWS_REGION ?? options.env?.AWS_DEFAULT_REGION,
    awsInteractionMode: options.flags.awsInteractionMode,
    providerSessionName: options.flags.providerSessionName,
  };
}

function requireCloudWebDriverPlatform(
  platform: PlatformSelector | undefined,
  message: string,
): 'android' | 'ios' {
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', message);
}

function requireFlag(value: string | undefined, message: string): string {
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

function requireEnv(env: EnvMap | undefined, name: string, command: string): string {
  const value = env?.[name];
  if (value) return value;
  throw new AppError('INVALID_ARGS', `${command} requires ${name} in the environment.`);
}

function buildCloudWebDriverClientId(
  provider: CloudWebDriverKnownProviderName,
  stateDir: string,
  session: string | undefined,
  device: string | undefined,
): string {
  return crypto
    .createHash('sha256')
    .update(`${provider}\0${stateDir}\0${session ?? ''}\0${device ?? ''}`)
    .digest('hex')
    .slice(0, 16);
}
