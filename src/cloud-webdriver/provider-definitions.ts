import fs from 'node:fs';
import path from 'node:path';
import type { CloudArtifactsResult } from '../cloud-artifacts.ts';
import type { DaemonRequest } from '../daemon/types.ts';
import { AppError } from '../kernel/errors.ts';
import type { ProviderDeviceRuntime } from '../provider-device-runtime.ts';
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
  uploadBrowserStackApp,
} from './browserstack.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, type CloudWebDriverKnownProviderName } from './providers.ts';
import {
  buildCloudWebDriverBaseCapabilities,
  createCloudWebDriverRuntime,
  type CloudWebDriverPlatform,
} from './runtime.ts';

export type DefaultCloudWebDriverArtifactEnv = {
  BROWSERSTACK_USERNAME?: string;
  BROWSERSTACK_ACCESS_KEY?: string;
  BROWSERSTACK_SESSION_DETAILS_ENDPOINT?: string;
  AWS_REGION?: string;
  AWS_DEFAULT_REGION?: string;
};

export type DefaultCloudWebDriverProviderRuntimeEnv = DefaultCloudWebDriverArtifactEnv & {
  BROWSERSTACK_WEBDRIVER_ENDPOINT?: string;
  BROWSERSTACK_APP_UPLOAD_ENDPOINT?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AWS_DEVICE_FARM_PROJECT_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AWS_DEVICE_FARM_DEVICE_ARN?: string;
  AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN?: string;
  AWS_DEVICE_FARM_APP_ARN?: string;
};

export type CloudWebDriverProviderDefinition = {
  provider: CloudWebDriverKnownProviderName;
  createRuntime: (env: DefaultCloudWebDriverProviderRuntimeEnv) => ProviderDeviceRuntime;
  listArtifactsFromEnv: (
    providerSessionId: string,
    env: DefaultCloudWebDriverArtifactEnv,
  ) => Promise<CloudArtifactsResult | undefined>;
};

export const CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS: readonly CloudWebDriverProviderDefinition[] = [
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    createRuntime: (env) =>
      createCloudWebDriverRuntime({
        provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
        platform: 'android',
        deviceName: 'BrowserStack device',
        endpoint: env.BROWSERSTACK_WEBDRIVER_ENDPOINT ?? BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
        capabilityOverrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
        listArtifacts: async ({ provider, providerSessionId }) => {
          const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack artifact lookup');
          const accessKey = requireEnv(
            env,
            'BROWSERSTACK_ACCESS_KEY',
            'BrowserStack artifact lookup',
          );
          return await listBrowserStackCloudArtifacts(provider, providerSessionId, {
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
          const app = await resolveBrowserStackAppReference({
            app: requireFlag(
              request,
              'providerApp',
              'BrowserStack requires --provider-app <bs://app-id-or-local-path>.',
            ),
            cwd: request.meta?.cwd,
            username,
            accessKey,
            uploadEndpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
          });
          return {
            ...base,
            platform,
            deviceName,
            auth: { username, accessKey },
            uploadApp: createBrowserStackUploadApp({
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
              configured: buildCloudWebDriverBaseCapabilities(platform, deviceName),
            }),
          };
        },
      }),
    listArtifactsFromEnv: async (providerSessionId, env) => {
      const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack artifact lookup');
      const accessKey = requireEnv(env, 'BROWSERSTACK_ACCESS_KEY', 'BrowserStack artifact lookup');
      return await listBrowserStackCloudArtifacts(
        CLOUD_WEBDRIVER_PROVIDERS.browserStack,
        providerSessionId,
        {
          username,
          accessKey,
          endpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
        },
      );
    },
  },
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    createRuntime: (env) =>
      createCloudWebDriverRuntime({
        provider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
        endpoint: 'http://127.0.0.1/',
        platform: 'android',
        deviceName: 'AWS Device Farm device',
        capabilityOverrides: AWS_DEVICE_FARM_CAPABILITY_OVERRIDES,
        listArtifacts: async ({ provider, providerSessionId }) => {
          const client = createAwsCliDeviceFarmClient({
            region:
              env.AWS_REGION ??
              env.AWS_DEFAULT_REGION ??
              readAwsRegionFromDeviceFarmArn(providerSessionId ?? ''),
          });
          return await listAwsDeviceFarmCloudArtifacts(provider, providerSessionId, client);
        },
        prepareSession: async ({ req, lease, base }) => {
          const request = requireRequest(req, 'AWS Device Farm');
          const platform = requireRequestPlatform(request, 'AWS Device Farm');
          const sessionOptions = {
            client: createAwsCliDeviceFarmClient({
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
        region:
          env.AWS_REGION ??
          env.AWS_DEFAULT_REGION ??
          readAwsRegionFromDeviceFarmArn(providerSessionId),
      });
      return await listAwsDeviceFarmCloudArtifacts(
        CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
        providerSessionId,
        client,
      );
    },
  },
];

export function findCloudWebDriverProviderDefinition(
  provider: string | undefined,
): CloudWebDriverProviderDefinition | undefined {
  return CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS.find((entry) => entry.provider === provider);
}

async function resolveBrowserStackAppReference(options: {
  app: string;
  cwd?: string;
  username: string;
  accessKey: string;
  uploadEndpoint?: string;
}): Promise<string> {
  if (isProviderAppReference(options.app)) return options.app;
  const appPath = path.resolve(options.cwd ?? process.cwd(), options.app);
  if (!fs.existsSync(appPath)) {
    throw new AppError(
      'INVALID_ARGS',
      'BrowserStack --provider-app must be a bs:// app id, URL, or existing local app path.',
      { providerApp: options.app },
    );
  }
  return await uploadBrowserStackApp(appPath, {
    username: options.username,
    accessKey: options.accessKey,
    endpoint: options.uploadEndpoint,
  });
}

function isProviderAppReference(value: string): boolean {
  return value.startsWith('bs://') || /^https?:\/\//.test(value);
}

function requireRequest(req: DaemonRequest | undefined, providerLabel: string): DaemonRequest {
  if (req) return req;
  throw new AppError(
    'INVALID_ARGS',
    `${providerLabel} lease allocation requires provider profile flags on the request.`,
  );
}

function requireRequestPlatform(req: DaemonRequest, providerLabel: string): CloudWebDriverPlatform {
  const platform = req.flags?.platform;
  if (platform === 'android' || platform === 'ios') return platform;
  throw new AppError('INVALID_ARGS', `${providerLabel} requires --platform ios|android.`);
}

function requireFlag(
  req: DaemonRequest,
  key: keyof NonNullable<DaemonRequest['flags']>,
  message: string,
): string {
  const value = readFlag(req, key);
  if (value) return value;
  throw new AppError('INVALID_ARGS', message);
}

function readFlag(
  req: DaemonRequest,
  key: keyof NonNullable<DaemonRequest['flags']>,
): string | undefined {
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
  req: DaemonRequest,
  env: DefaultCloudWebDriverProviderRuntimeEnv,
  flagKey: keyof NonNullable<DaemonRequest['flags']>,
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
  req: DaemonRequest,
): 'INTERACTIVE' | 'NO_VIDEO' | 'VIDEO_ONLY' | undefined {
  const value = readFlag(req, 'awsInteractionMode');
  if (value === 'INTERACTIVE' || value === 'NO_VIDEO' || value === 'VIDEO_ONLY') return value;
  return undefined;
}

function readAwsRegionFromDeviceFarmArn(arn: string): string | undefined {
  return /^arn:[^:]+:devicefarm:([^:]+):/.exec(arn)?.[1];
}

function dasherize(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`);
}
