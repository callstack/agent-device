import fs from 'node:fs';
import path from 'node:path';
import type { CloudArtifactsResult } from '../cloud-artifacts.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import type { DaemonRequest } from '../daemon/types.ts';
import { AppError } from '../kernel/errors.ts';
import type { ProviderDeviceRuntime } from '../provider-device-runtime.ts';
import {
  createAwsCliDeviceFarmClient,
  createAwsDeviceFarmWebDriverRuntime,
  listAwsDeviceFarmCloudArtifacts,
} from './aws-device-farm.ts';
import {
  createBrowserStackWebDriverRuntime,
  listBrowserStackCloudArtifacts,
  uploadBrowserStackApp,
} from './browserstack.ts';
import { CLOUD_WEBDRIVER_PROVIDERS, type CloudWebDriverKnownProviderName } from './providers.ts';
import type { CloudWebDriverPlatform } from './runtime.ts';

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
  createRuntime: (params: {
    req: DaemonRequest;
    lease: DeviceLease;
    env: DefaultCloudWebDriverProviderRuntimeEnv;
  }) => Promise<ProviderDeviceRuntime> | ProviderDeviceRuntime;
  listArtifactsFromEnv: (
    providerSessionId: string,
    env: DefaultCloudWebDriverArtifactEnv,
  ) => Promise<CloudArtifactsResult | undefined>;
};

export const CLOUD_WEBDRIVER_PROVIDER_DEFINITIONS: readonly CloudWebDriverProviderDefinition[] = [
  {
    provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
    createRuntime: async ({ req, lease, env }) => {
      const username = requireEnv(env, 'BROWSERSTACK_USERNAME', 'BrowserStack');
      const accessKey = requireEnv(env, 'BROWSERSTACK_ACCESS_KEY', 'BrowserStack');
      const platform = requireRequestPlatform(req, 'BrowserStack');
      const deviceName = requireFlag(req, 'device', 'BrowserStack requires --device <name>.');
      const osVersion = requireFlag(
        req,
        'providerOsVersion',
        'BrowserStack requires --provider-os-version <version>.',
      );
      const app = await resolveBrowserStackAppReference({
        app: requireFlag(
          req,
          'providerApp',
          'BrowserStack requires --provider-app <bs://app-id-or-local-path>.',
        ),
        cwd: req.meta?.cwd,
        username,
        accessKey,
        uploadEndpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
      });
      return createBrowserStackWebDriverRuntime({
        username,
        accessKey,
        platform,
        deviceName,
        osVersion,
        app,
        projectName: readFlag(req, 'providerProject'),
        buildName: readFlag(req, 'providerBuild') ?? lease.runId,
        sessionName: readFlag(req, 'providerSessionName') ?? lease.leaseId,
        endpoint: env.BROWSERSTACK_WEBDRIVER_ENDPOINT,
        uploadEndpoint: env.BROWSERSTACK_APP_UPLOAD_ENDPOINT,
        sessionDetailsEndpoint: env.BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
      });
    },
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
    createRuntime: ({ req, lease, env }) => {
      const platform = requireRequestPlatform(req, 'AWS Device Farm');
      return createAwsDeviceFarmWebDriverRuntime({
        projectArn: requireAwsValue(
          req,
          env,
          'awsProjectArn',
          'AGENT_DEVICE_AWS_DEVICE_FARM_PROJECT_ARN',
          'AWS_DEVICE_FARM_PROJECT_ARN',
        ),
        deviceArn: requireAwsValue(
          req,
          env,
          'awsDeviceArn',
          'AGENT_DEVICE_AWS_DEVICE_FARM_DEVICE_ARN',
          'AWS_DEVICE_FARM_DEVICE_ARN',
        ),
        appArn:
          readFlag(req, 'awsAppArn') ??
          env.AGENT_DEVICE_AWS_DEVICE_FARM_APP_ARN ??
          env.AWS_DEVICE_FARM_APP_ARN,
        region: readFlag(req, 'awsRegion') ?? env.AWS_REGION ?? env.AWS_DEFAULT_REGION,
        platform,
        deviceName: readFlag(req, 'device') ?? 'AWS Device Farm device',
        sessionName: readFlag(req, 'providerSessionName') ?? lease.leaseId,
        interactionMode: readAwsInteractionMode(req),
      });
    },
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
