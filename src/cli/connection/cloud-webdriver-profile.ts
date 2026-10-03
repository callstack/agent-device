import {
  CLOUD_WEBDRIVER_PROFILE_FIELDS,
  CLOUD_WEBDRIVER_PROVIDERS,
  readAwsDeviceFarmRegionFromArn,
  type CloudWebDriverKnownProviderName,
} from '@agent-device/provider-webdriver';
import {
  isBrowserStackAppReference,
  isTestMuAppReference,
} from '@agent-device/provider-webdriver/providers';
import { rejectRefusedProviderProfileFields } from '@agent-device/contracts/provider-profile-fields';
import type { RemoteConfigProfile } from '../../remote/remote-config-schema.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformSelector } from '@agent-device/kernel/device';
import type { CliFlags } from '@agent-device/contracts/command';
import fs from 'node:fs';
import path from 'node:path';
import { type EnvMap } from '@agent-device/kernel/source-value';
import { readCloudDeviceFeatureProfileFields, readMetroProfileFields } from './profile-fields.ts';
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
  const buildProfileFields = requireConnectProfileBuilder(options.provider);
  rejectRefusedProviderProfileFields(
    options.flags,
    CLOUD_WEBDRIVER_PROFILE_FIELDS[options.provider],
  );
  const providerConfig = buildProfileFields(options);
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
    // Verification reads these flags; it must see the canonical reference the profile saved,
    // not the spelling typed on the command line.
    ...(providerConfig.providerApp
      ? { extraFlags: { providerApp: providerConfig.providerApp } }
      : {}),
  });
}

type ConnectProfileBuilder = (options: {
  flags: CliFlags;
  env?: EnvMap;
  cwd: string;
}) => RemoteConfigProfile;

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
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.testMu,
    buildProfileFields: testMuProfileFields,
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

/** A hosted Appium hub picks its device by exact name + OS version and installs one app reference. */
type HubProviderProfile = {
  command: string;
  label: string;
  credentialEnv: readonly [string, string];
  /** Scheme of the provider's own app references, e.g. `bs://` or `lt://`. */
  appScheme: string;
  /** The hub's own reference grammar, checked here so a malformed id fails at connect. */
  isAppReference: (reference: string) => boolean;
  appHint: string;
};

const BROWSERSTACK_HUB_PROFILE: HubProviderProfile = {
  command: 'connect browserstack',
  label: 'BrowserStack',
  credentialEnv: ['BROWSERSTACK_USERNAME', 'BROWSERSTACK_ACCESS_KEY'],
  appScheme: 'bs://',
  isAppReference: isBrowserStackAppReference,
  appHint: '<bs://app-id-or-local-path>',
};

const TESTMU_HUB_PROFILE: HubProviderProfile = {
  command: 'connect testmu',
  label: 'TestMu AI',
  credentialEnv: ['LT_USERNAME', 'LT_ACCESS_KEY'],
  appScheme: 'lt://',
  isAppReference: isTestMuAppReference,
  appHint: '<lt://app-id, URL, or local path>',
};

function browserStackProfileFields(options: {
  flags: CliFlags;
  env?: EnvMap;
  cwd: string;
}): RemoteConfigProfile {
  return hubProviderProfileFields(BROWSERSTACK_HUB_PROFILE, options);
}

function testMuProfileFields(options: {
  flags: CliFlags;
  env?: EnvMap;
  cwd: string;
}): RemoteConfigProfile {
  return {
    ...hubProviderProfileFields(TESTMU_HUB_PROFILE, options),
    providerDeviceType: options.flags.providerDeviceType,
  };
}

function hubProviderProfileFields(
  hub: HubProviderProfile,
  options: { flags: CliFlags; env?: EnvMap; cwd: string },
): RemoteConfigProfile {
  for (const name of hub.credentialEnv) requireEnv(options.env, name, hub.command);
  const platform = requireCloudWebDriverPlatform(
    options.flags.platform,
    `${hub.command} requires --platform ios|android.`,
  );
  const device = requireFlag(options.flags.device, `${hub.command} requires --device <name>.`);
  const providerOsVersion = requireFlag(
    options.flags.providerOsVersion,
    `${hub.command} requires --provider-os-version <version>.`,
  );
  const providerApp = normalizeHubAppReference(
    hub,
    requireFlag(
      options.flags.providerApp,
      `${hub.command} requires --provider-app ${hub.appHint}.`,
    ),
    options.cwd,
  );
  return {
    platform,
    device,
    providerOsVersion,
    providerApp,
    providerProject: options.flags.providerProject,
    providerBuild: options.flags.providerBuild,
    providerSessionName: options.flags.providerSessionName,
    ...readCloudDeviceFeatureProfileFields(options.flags),
  };
}

function normalizeHubAppReference(hub: HubProviderProfile, app: string, cwd: string): string {
  if (/^https?:\/\//i.test(app)) return app;
  // URI schemes are case-insensitive; the hub only matches the lower-case spelling.
  if (app.slice(0, hub.appScheme.length).toLowerCase() === hub.appScheme) {
    const reference = `${hub.appScheme}${app.slice(hub.appScheme.length)}`;
    if (hub.isAppReference(reference)) return reference;
    throw new AppError(
      'INVALID_ARGS',
      `${hub.command} --provider-app ${app} is not a valid ${hub.appScheme} app reference.`,
      { hint: `Pass ${hub.appHint}.` },
    );
  }
  const resolvedPath = path.resolve(cwd, app);
  try {
    if (fs.statSync(resolvedPath).isFile()) return resolvedPath;
  } catch {
    // Report one stable profile error below.
  }
  throw new AppError('INVALID_ARGS', `${hub.label} app file not found: ${resolvedPath}`);
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
  const awsProjectArn = requireAwsProfileValue(
    flags.awsProjectArn,
    env,
    ['AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN', 'AWS_DEVICE_FARM_PROJECT_ARN'],
    'connect aws-device-farm requires --aws-project-arn <arn> or AWS_DEVICE_FARM_PROJECT_ARN.',
  );
  return {
    platform,
    device: flags.device,
    awsProjectArn,
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
    awsRegion:
      readAwsProfileValue(flags.awsRegion, env, ['AWS_REGION', 'AWS_DEFAULT_REGION']) ??
      readAwsDeviceFarmRegionFromArn(awsProjectArn),
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
