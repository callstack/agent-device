import type { CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { LeaseLifecycleContext } from '@agent-device/contracts/device';
import type { ProviderDeviceType } from '@agent-device/contracts/remote';
import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderWebDriverDependencies } from './dependencies.ts';
import {
  AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
  createAwsCliDeviceFarmClient,
  createAwsDeviceFarmPrepareSession,
  listAwsDeviceFarmCloudArtifacts,
} from './aws-device-farm.ts';
import {
  BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
  BROWSERSTACK_APP_UPLOAD_ENDPOINT,
  BROWSERSTACK_CAPABILITY_OVERRIDES,
  buildBrowserStackCapabilities,
  createBrowserStackUploadApp,
  listBrowserStackCloudArtifacts,
  resolveBrowserStackAppReference,
} from './browserstack.ts';
import {
  buildBrowserStackDeviceFeatureCapabilities,
  readBrowserStackDeviceFeatureFields,
} from './browserstack-device-features.ts';
import type { CloudWebDriverCapabilityOverrides } from './capabilities.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, type CloudWebDriverKnownProviderName } from './providers.ts';
import { readAwsDeviceFarmRegionFromArn } from './connection-verification.ts';
import {
  buildCloudWebDriverBaseCapabilities,
  createCloudWebDriverRuntime,
  type CloudWebDriverPlatform,
  type CloudWebDriverRuntime,
} from './runtime.ts';

export type DefaultCloudWebDriverArtifactEnv = {
  BROWSERSTACK_USERNAME?: string;
  BROWSERSTACK_ACCESS_KEY?: string;
  BROWSERSTACK_SESSION_DETAILS_ENDPOINT?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
  LT_USERNAME?: string;
  LT_ACCESS_KEY?: string;
  TESTMU_API_ENDPOINT?: string;
};

export type DefaultCloudWebDriverProviderRuntimeEnv = DefaultCloudWebDriverArtifactEnv & {
  BROWSERSTACK_WEBDRIVER_ENDPOINT?: string;
  BROWSERSTACK_APP_UPLOAD_ENDPOINT?: string;
  TESTMU_WEBDRIVER_ENDPOINT?: string;
  TESTMU_APP_UPLOAD_ENDPOINT?: string;
  TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN?: string;
  AWS_DEVICE_FARM_APP_ARN?: string;
};

/**
 * TestMu (formerly LambdaTest) real devices, and virtual devices (emulators and simulators), behind
 * one Appium hub. Only what `createRuntime` needs synchronously lives here; the session,
 * upload, and artifact code loads on first use so the package entry stays as lean as it was.
 */
const TESTMU_WEBDRIVER_ENDPOINT = 'https://mobile-hub.lambdatest.com/wd/hub/';
const TESTMU_CAPABILITY_OVERRIDES = {
  install: {
    support: 'partial',
    note: 'Local app artifacts are uploaded to TestMu AI as real- or virtual-device apps (lt://), then installed with Appium.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'Use the TestMu AI tunnel for network access to local hosts; agent-device port reverse is not available.',
  },
  artifacts: {
    support: 'supported',
    note: 'TestMu AI session details expose provider-hosted video, Appium logs, device logs, network logs, and dashboard links.',
  },
} as const satisfies CloudWebDriverCapabilityOverrides;

const loadTestMu = async () => await import('./testmu.ts');
const loadTestMuDeviceFeatures = async () => await import('./testmu-device-features.ts');

const AWS_DEVICE_FARM_FIELDS_REFUSED = {
  awsProjectArn: 'refused',
  awsDeviceArn: 'refused',
  awsAppArn: 'refused',
  awsRegion: 'refused',
  awsInteractionMode: 'refused',
} as const;

const BROWSERSTACK_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
  label: 'BrowserStack',
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'consumed',
    providerDeviceType: 'refused',
    providerProject: 'consumed',
    providerBuild: 'consumed',
    providerSessionName: 'consumed',
    providerDeviceOrientation: 'consumed',
    providerGeoLocation: 'consumed',
    providerTimezone: 'consumed',
    providerAppiumVersion: 'consumed',
    providerLanguage: 'consumed',
    providerLocale: 'consumed',
    providerNetworkProfile: 'consumed',
    providerCustomNetwork: 'consumed',
    providerNoResignApp: 'consumed',
    ...AWS_DEVICE_FARM_FIELDS_REFUSED,
  },
};

const AWS_DEVICE_FARM_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
  label: 'AWS Device Farm',
  fields: {
    providerApp: 'refused',
    providerOsVersion: 'refused',
    providerDeviceType: 'refused',
    providerProject: 'refused',
    providerBuild: 'refused',
    providerSessionName: 'consumed',
    providerDeviceOrientation: 'refused',
    providerGeoLocation: 'refused',
    providerTimezone: 'refused',
    providerAppiumVersion: 'refused',
    providerLanguage: 'refused',
    providerLocale: 'refused',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    awsProjectArn: 'consumed',
    awsDeviceArn: 'consumed',
    awsAppArn: 'consumed',
    awsRegion: 'consumed',
    awsInteractionMode: 'consumed',
  },
};

const TESTMU_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
  provider: CLOUD_WEBDRIVER_PROVIDERS.testMu,
  label: 'TestMu AI',
  fields: {
    providerApp: 'consumed',
    providerOsVersion: 'consumed',
    providerDeviceType: 'consumed',
    providerProject: 'consumed',
    providerBuild: 'consumed',
    providerSessionName: 'consumed',
    providerDeviceOrientation: 'consumed',
    providerGeoLocation: 'consumed',
    providerTimezone: 'consumed',
    providerAppiumVersion: 'consumed',
    providerLanguage: 'consumed',
    providerLocale: 'consumed',
    providerNetworkProfile: 'refused',
    providerCustomNetwork: 'refused',
    providerNoResignApp: 'refused',
    ...AWS_DEVICE_FARM_FIELDS_REFUSED,
  },
};

/** The profile fields each hub provider reads, for routes that check them before a runtime exists. */
export const CLOUD_WEBDRIVER_PROFILE_FIELDS: Readonly<
  Record<CloudWebDriverKnownProviderName, ProviderProfileFieldDeclaration>
> = {
  [CLOUD_WEBDRIVER_PROVIDERS.browserStack]: BROWSERSTACK_PROFILE_FIELDS,
  [CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm]: AWS_DEVICE_FARM_PROFILE_FIELDS,
  [CLOUD_WEBDRIVER_PROVIDERS.testMu]: TESTMU_PROFILE_FIELDS,
};

export type CloudWebDriverProviderDefinition = {
  provider: CloudWebDriverKnownProviderName;
  /** Every profile field, consumed or refused; lease allocation refuses the refused ones. */
  profileFields: ProviderProfileFieldDeclaration;
  /** Receives `profileFields`, which the runtime requires, so the two cannot drift apart. */
  createRuntime: (
    env: DefaultCloudWebDriverProviderRuntimeEnv,
    profileFields: ProviderProfileFieldDeclaration,
  ) => CloudWebDriverRuntime;
  listArtifactsFromEnv: (
    providerSessionId: string,
    env: DefaultCloudWebDriverArtifactEnv,
  ) => Promise<CloudArtifactsResult | undefined>;
};

export function createCloudWebDriverProviderDefinitions(
  dependencies: ProviderWebDriverDependencies,
): readonly CloudWebDriverProviderDefinition[] {
  return [
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
      profileFields: BROWSERSTACK_PROFILE_FIELDS,
      createRuntime: (env, profileFields) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
          profileFields,
          platform: 'android',
          deviceName: 'BrowserStack device',
          endpoint: env.BROWSERSTACK_WEBDRIVER_ENDPOINT ?? BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
          capabilityOverrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) => {
            const username = requireEnv(
              env,
              'BROWSERSTACK_USERNAME',
              'BrowserStack artifact lookup',
            );
            const accessKey = requireEnv(
              env,
              'BROWSERSTACK_ACCESS_KEY',
              'BrowserStack artifact lookup',
            );
            return await listBrowserStackCloudArtifacts(provider, providerSessionId, {
              clientVersion: dependencies.clientVersion,
              username,
              accessKey,
              endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
            });
          },
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'BrowserStack');
            const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack');
            const accessKey = requireEnv(env, 'BROWSERSTACK_ACCESS_KEY', 'BrowserStack');
            const platform = requireRequestPlatform(request, 'BrowserStack');
            const deviceName = requireFlag(
              request,
              'device',
              'BrowserStack requires --device <name>.',
            );
            const osVersion = requireFlag(
              request,
              'providerOsVersion',
              'BrowserStack requires --provider-os-version <version>.',
            );
            const app = await resolveBrowserStackAppReference(
              requireFlag(
                request,
                'providerApp',
                'BrowserStack requires --provider-app <bs://app-id-or-local-path>.',
              ),
              {
                clientVersion: dependencies.clientVersion,
                username,
                accessKey,
                endpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
                cwd: request.cwd,
                // A local IPA/APK upload can run long (130 MB is routine); an
                // upload is not a billed resource, so the request's cancellation
                // may simply abort it — unlike the session creation that follows.
                signal: request.signal,
              },
            );
            return {
              ...base,
              platform,
              deviceName,
              auth: { username, accessKey },
              uploadApp: createBrowserStackUploadApp({
                clientVersion: dependencies.clientVersion,
                username,
                accessKey,
                endpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT,
              }),
              webdriverCapabilities: buildBrowserStackCapabilities({
                deviceName,
                osVersion,
                app,
                projectName: readFlag(request, 'providerProject'),
                buildName: readFlag(request, 'providerBuild') ?? lease.runId,
                sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
                deviceFeatures: buildBrowserStackDeviceFeatureCapabilities(
                  readBrowserStackDeviceFeatureFields(request.flags),
                  platform,
                ),
                configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
              }),
            };
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) => {
        const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack artifact lookup');
        const accessKey = requireEnv(
          env,
          'BROWSERSTACK_ACCESS_KEY',
          'BrowserStack artifact lookup',
        );
        return await listBrowserStackCloudArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.browserStack,
          providerSessionId,
          {
            clientVersion: dependencies.clientVersion,
            username,
            accessKey,
            endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
          },
        );
      },
    },
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
      profileFields: AWS_DEVICE_FARM_PROFILE_FIELDS,
      createRuntime: (env, profileFields) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
          profileFields,
          endpoint: 'http://127.0.0.1/',
          platform: 'android',
          deviceName: 'AWS Device Farm device',
          capabilityOverrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) => {
            const client = createAwsCliDeviceFarmClient({
              runHostCommand: dependencies.runHostCommand,
              region:
                env.AWS_REGION ??
                env.AWS_DEFAULT_REGION ??
                readAwsDeviceFarmRegionFromArn(providerSessionId ?? ''),
            });
            return await listAwsDeviceFarmCloudArtifacts(provider, providerSessionId, client);
          },
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'AWS Device Farm');
            const platform = requireRequestPlatform(request, 'AWS Device Farm');
            const sessionOptions = {
              client: createAwsCliDeviceFarmClient({
                runHostCommand: dependencies.runHostCommand,
                region: readFlag(request, 'awsRegion') ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
              }),
              projectArn: requireAwsValue(
                request,
                env,
                'awsProjectArn',
                'AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN',
                'AWS_DEVICE_FARM_PROJECT_ARN',
              ),
              deviceArn: requireAwsValue(
                request,
                env,
                'awsDeviceArn',
                'AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN',
                'AWS_DEVICE_FARM_DEVICE_ARN',
              ),
              appArn:
                readFlag(request, 'awsAppArn') ??
                env.AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN ??
                env.AWS_DEVICE_FARM_APP_ARN,
              platform,
              deviceName: readFlag(request, 'device') ?? 'AWS Device Farm device',
              sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
              interactionMode: readAwsInteractionMode(request),
            };
            return await createAwsDeviceFarmPrepareSession(sessionOptions)({ lease, req, base });
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) => {
        const client = createAwsCliDeviceFarmClient({
          runHostCommand: dependencies.runHostCommand,
          region:
            env.AWS_REGION ??
            env.AWS_DEFAULT_REGION ??
            readAwsDeviceFarmRegionFromArn(providerSessionId),
        });
        return await listAwsDeviceFarmCloudArtifacts(
          CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
          providerSessionId,
          client,
        );
      },
    },
    {
      provider: CLOUD_WEBDRIVER_PROVIDERS.testMu,
      profileFields: TESTMU_PROFILE_FIELDS,
      createRuntime: (env, profileFields) =>
        createCloudWebDriverRuntime({
          clientVersion: dependencies.clientVersion,
          provider: CLOUD_WEBDRIVER_PROVIDERS.testMu,
          profileFields,
          platform: 'android',
          deviceName: 'TestMu AI device',
          endpoint: env.TESTMU_WEBDRIVER_ENDPOINT ?? TESTMU_WEBDRIVER_ENDPOINT,
          capabilityOverrides: TESTMU_CAPABILITY_OVERRIDES,
          listArtifacts: async ({ provider, providerSessionId }) =>
            await listTestMuArtifactsFromEnv(provider, providerSessionId, env),
          prepareSession: async ({ req, lease, base }) => {
            const request = requireRequest(req, 'TestMu AI');
            const { buildTestMuCapabilities, createTestMuUploadApp, resolveTestMuAppReference } =
              await loadTestMu();
            const {
              buildTestMuDeviceFeatureCapabilities,
              readTestMuDeviceFeatureFields,
              readTestMuDeviceType,
            } = await loadTestMuDeviceFeatures();
            const deviceType = readTestMuDeviceType(request.flags);
            const uploadEndpoint = testMuAppUploadEndpoint(env, deviceType);
            const credentials = requireTestMuCredentials(env, 'TestMu AI');
            const platform = requireRequestPlatform(request, 'TestMu AI');
            const deviceName = requireFlag(
              request,
              'device',
              'TestMu AI requires --device <name>.',
            );
            const osVersion = requireFlag(
              request,
              'providerOsVersion',
              'TestMu AI requires --provider-os-version <version>.',
            );
            const upload = {
              clientVersion: dependencies.clientVersion,
              ...credentials,
              deviceType,
              endpoint: uploadEndpoint,
            };
            const app = await resolveTestMuAppReference(
              requireFlag(
                request,
                'providerApp',
                'TestMu AI requires --provider-app <lt://app-id, URL, or local path>.',
              ),
              { ...upload, cwd: request.cwd, signal: request.signal },
            );
            return {
              ...base,
              platform,
              deviceName,
              auth: credentials,
              uploadApp: createTestMuUploadApp(upload),
              webdriverCapabilities: buildTestMuCapabilities({
                platform,
                deviceType,
                deviceName,
                osVersion,
                app,
                projectName: readFlag(request, 'providerProject'),
                buildName: readFlag(request, 'providerBuild') ?? lease.runId,
                sessionName: readFlag(request, 'providerSessionName') ?? lease.leaseId,
                deviceFeatures: buildTestMuDeviceFeatureCapabilities(
                  readTestMuDeviceFeatureFields(request.flags),
                ),
                configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
              }),
            };
          },
        }),
      listArtifactsFromEnv: async (providerSessionId, env) =>
        await listTestMuArtifactsFromEnv(CLOUD_WEBDRIVER_PROVIDERS.testMu, providerSessionId, env),
    },
  ];

  async function listTestMuArtifactsFromEnv(
    provider: string,
    providerSessionId: string | undefined,
    env: DefaultCloudWebDriverArtifactEnv,
  ): Promise<CloudArtifactsResult | undefined> {
    const { listTestMuCloudArtifacts } = await loadTestMu();
    return await listTestMuCloudArtifacts(provider, providerSessionId, {
      clientVersion: dependencies.clientVersion,
      ...requireTestMuCredentials(env, 'TestMu AI artifact lookup'),
      endpoint: env.TESTMU_API_ENDPOINT,
    });
  }
}

function requireTestMuCredentials(
  env: DefaultCloudWebDriverArtifactEnv,
  providerLabel: string,
): { username: string; accessKey: string } {
  return {
    username: requireEnv(env, 'LT_USERNAME', providerLabel),
    accessKey: requireEnv(env, 'LT_ACCESS_KEY', providerLabel),
  };
}

/** Each pool has its own upload API, so each has its own override. */
function testMuAppUploadEndpoint(
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  deviceType: ProviderDeviceType,
): string | undefined {
  return deviceType === 'real'
    ? env.TESTMU_REAL_DEVICE_APP_UPLOAD_ENDPOINT
    : env.TESTMU_APP_UPLOAD_ENDPOINT;
}

function requireRequest(
  req: LeaseLifecycleContext | undefined,
  providerLabel: string,
): LeaseLifecycleContext {
  if (req) return req;
  throw new AppError(
    'INVALID_ARGS',
    `${providerLabel} lease allocation requires provider profile flags on the request.`,
  );
}

function requireRequestPlatform(
  req: LeaseLifecycleContext,
  providerLabel: string,
): CloudWebDriverPlatform {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires --platform ios|android.`);
}

function requireFlag(req: LeaseLifecycleContext, key: string, message: string): string {
  const value = readFlag(req, key);
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

function readFlag(req: LeaseLifecycleContext, key: string): string | undefined {
  const value = req.flags?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireEnv(
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  key: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  providerLabel: string,
): string {
  const value = env[key];
  if (value) return value;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires ${key} in the environment.`);
}

function requireAwsValue(
  req: LeaseLifecycleContext,
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  flagKey: string,
  primaryEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
  fallbackEnv: keyof DefaultCloudWebDriverProviderRuntimeEnv,
): string {
  const value = readFlag(req, flagKey) ?? env[primaryEnv] ?? env[fallbackEnv];
  if (value) return value;
  throw new AppError(
    'INVALID_ARGS',
    `AWS Device Farm requires --${dasherize(String(flagKey))} or ${fallbackEnv}.`,
  );
}

function readAwsInteractionMode(
  req: LeaseLifecycleContext,
): 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY' | undefined {
  const value = readFlag(req, 'awsInteractionMode');
  if (value === 'INTERACTIVE' || value === 'NO_VIDEO' || value === 'VIDEO_ONLY') return value;
  return undefined;
}

function dasherize(value: string): string {
  return value.replaceAll(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
