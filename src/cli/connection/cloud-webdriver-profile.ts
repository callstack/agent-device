import { CLOUD_WEBDRIVER_PROVIDERS } from '../../cloud-webdriver/providers.ts';
import type { CloudWebDriverKnownProviderName } from '../../cloud-webdriver/providers.ts';
import type { RemoteConfigProfile } from '../../remote/remote-config-schema.ts';
import { AppError } from '../../kernel/errors.ts';
import type { PlatformSelector } from '../../kernel/device.ts';
import type { CliFlags } from '../../commands/cli-grammar/flag-types.ts';
import type { EnvMap } from '../../utils/env-map.ts';
import { readMetroProfileFields } from './profile-fields.ts';
import { persistAndResolveGeneratedProfile } from './generated-config.ts';
import { resolveRequestedLeaseBackend } from '../commands/connection-runtime.ts';
import { buildConnectClientId } from './client-id.ts';

export function resolveCloudWebDriverConnectProfile(options: {
  provider: CloudWebDriverKnownProviderName;
  flags: CliFlags;
  stateDir: string;
  cwd: string;
  env?: EnvMap;
}): { flags: CliFlags; remoteConfigPath: string } {
  const providerConfig = requireConnectProfileBuilder(options.provider)(options);
  const clientId = buildConnectClientId(
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
    ...readMetroProfileFields(options.flags),
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
  const { env, flags } = options;
  const platform = requireCloudWebDriverPlatform(
    flags.platform,
    'connect aws-device-farm requires --platform ios|android.',
  );
  return {
    platform,
    device: flags.device,
    awsProjectArn: requireAwsProfileValue(
      flags.awsProjectArn,
      env,
      ['AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN', 'AWS_DEVICE_FARM_PROJECT_ARN'],
      'connect aws-device-farm requires --aws-project-arn <arn> or AWS_DEVICE_FARM_PROJECT_ARN.',
    ),
    awsDeviceArn: requireAwsProfileValue(
      flags.awsDeviceArn,
      env,
      ['AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN', 'AWS_DEVICE_FARM_DEVICE_ARN'],
      'connect aws-device-farm requires --aws-device-arn <arn> or AWS_DEVICE_FARM_DEVICE_ARN.',
    ),
    awsAppArn: readAwsProfileValue(flags.awsAppArn, env, [
      'AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN',
      'AWS_DEVICE_FARM_APP_ARN',
    ]),
    awsRegion: readAwsProfileValue(flags.awsRegion, env, ['AWS_REGION', 'AWS_DEFAULT_REGION']),
    awsInteractionMode: flags.awsInteractionMode,
    providerSessionName: flags.providerSessionName,
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

function requireAwsProfileValue(
  flagValue: string | undefined,
  env: EnvMap | undefined,
  envNames: readonly string[],
  message: string,
): string {
  return requireFlag(readAwsProfileValue(flagValue, env, envNames), message);
}

function readAwsProfileValue(
  flagValue: string | undefined,
  env: EnvMap | undefined,
  envNames: readonly string[],
): string | undefined {
  if (flagValue) return flagValue;
  return envNames.map((name) => env?.[name]).find((value): value is string => Boolean(value));
}
