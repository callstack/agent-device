import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudArtifact, CloudArtifactsResult } from '../cloud-artifacts.ts';
import {
  createCloudWebDriverCapabilities,
  type CloudWebDriverCapabilityOverrides,
  type CloudWebDriverProviderCapabilities,
} from './capabilities.ts';
import {
  createCloudWebDriverRuntime,
  type CloudWebDriverPlatform,
  type CloudWebDriverRuntimeOptions,
  type CloudWebDriverUploadApp,
} from './runtime.ts';
import type { ProviderDeviceRuntime } from '../provider-device-runtime.ts';
import type { DeviceLease } from '../daemon/lease-registry.ts';
import { AppError } from '../kernel/errors.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from './providers.ts';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { cloudArtifactsReadyOrPending } from './artifact-results.ts';
import {
  basicAuthHeader,
  resolveLeaseValue,
  trimTrailingSlash,
  type LeaseValue,
} from './webdriver-utils.ts';

const BROWSERSTACK_PROVIDER = CLOUD_WEBDRIVER_PROVIDERS.browserStack;
export const BROWSERSTACK_APP_AUTOMATE_ENDPOINT = 'https://hub-cloud.browserstack.com/wd/hub/';
export const BROWSERSTACK_APP_UPLOAD_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/upload';
const BROWSERSTACK_SESSION_DETAILS_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/sessions';
export const BROWSERSTACK_CAPABILITY_OVERRIDES = {
  install: {
    support: 'partial',
    note: 'Local app artifacts are uploaded to BrowserStack App Automate, then installed with Appium.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'Use BrowserStack Local for network tunneling; agent-device port reverse is not available.',
  },
  artifacts: {
    support: 'supported',
    note: 'BrowserStack session details expose provider-hosted video, Appium logs, device logs, and dashboard links.',
  },
} as const satisfies CloudWebDriverCapabilityOverrides;

export type BrowserStackWebDriverRuntimeOptions = {
  username: string;
  accessKey: string;
  platform: CloudWebDriverPlatform;
  deviceName: string;
  osVersion: string;
  app?: string;
  projectName?: string;
  buildName?: LeaseValue<string>;
  sessionName?: LeaseValue<string>;
  webdriverCapabilities?:
    | Record<string, unknown>
    | ((lease: DeviceLease) => Record<string, unknown>);
  endpoint?: string | URL;
  uploadEndpoint?: string | URL;
  sessionDetailsEndpoint?: string | URL;
  deviceId?: CloudWebDriverRuntimeOptions['deviceId'];
  requestPolicy?: CloudWebDriverRuntimeOptions['requestPolicy'];
  prepareSession?: CloudWebDriverRuntimeOptions['prepareSession'];
};

export type BrowserStackCapabilitiesOptions = {
  deviceName: string;
  osVersion: string;
  app?: string;
  projectName?: string;
  buildName: string;
  sessionName: string;
  configured?: Record<string, unknown>;
};

/**
 * @internal BrowserStack capability builder used by integration tests.
 */
export function getBrowserStackWebDriverCapabilities(
  platform: CloudWebDriverPlatform,
): CloudWebDriverProviderCapabilities {
  return createCloudWebDriverCapabilities({
    provider: BROWSERSTACK_PROVIDER,
    platform,
    overrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
  });
}

/**
 * @internal BrowserStack runtime factory used by integration tests.
 */
export function createBrowserStackWebDriverRuntime(
  options: BrowserStackWebDriverRuntimeOptions,
): ProviderDeviceRuntime {
  const uploadEndpoint = options.uploadEndpoint ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT;
  const artifactOptions = {
    username: options.username,
    accessKey: options.accessKey,
    endpoint: options.sessionDetailsEndpoint ?? BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
  };
  return createCloudWebDriverRuntime({
    provider: BROWSERSTACK_PROVIDER,
    endpoint: options.endpoint ?? BROWSERSTACK_APP_AUTOMATE_ENDPOINT,
    platform: options.platform,
    deviceName: options.deviceName,
    auth: {
      username: options.username,
      accessKey: options.accessKey,
    },
    webdriverCapabilities: (lease) =>
      buildBrowserStackCapabilities({
        deviceName: options.deviceName,
        osVersion: options.osVersion,
        app: options.app,
        projectName: options.projectName,
        buildName: resolveLeaseValue(options.buildName, lease) ?? lease.runId,
        sessionName: resolveLeaseValue(options.sessionName, lease) ?? lease.leaseId,
        configured: resolveConfiguredBrowserStackCapabilities(options, lease),
      }),
    uploadApp: createBrowserStackUploadApp({
      username: options.username,
      accessKey: options.accessKey,
      endpoint: uploadEndpoint,
    }),
    listArtifacts: async ({ provider, providerSessionId }) =>
      await listBrowserStackCloudArtifacts(provider, providerSessionId, artifactOptions),
    deviceId: options.deviceId,
    prepareSession: options.prepareSession,
    requestPolicy: options.requestPolicy,
    capabilityOverrides: BROWSERSTACK_CAPABILITY_OVERRIDES,
  });
}

export type BrowserStackSessionDetailsOptions = {
  username: string;
  accessKey: string;
  endpoint?: string | URL;
};

export async function listBrowserStackCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  options: BrowserStackSessionDetailsOptions,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const details = await fetchBrowserStackSessionDetails(providerSessionId, options);
  const artifacts = mapBrowserStackArtifacts(provider, providerSessionId, details);
  return cloudArtifactsReadyOrPending({
    provider,
    providerSessionId,
    artifacts,
    pendingMessage: 'BrowserStack artifacts are not ready yet.',
  });
}

export type BrowserStackUploadOptions = {
  username: string;
  accessKey: string;
  endpoint?: string | URL;
};

export async function uploadBrowserStackApp(
  appPath: string,
  options: BrowserStackUploadOptions,
): Promise<string> {
  const file = await fs.readFile(appPath);
  const form = new FormData();
  form.set('file', new Blob([file]), path.basename(appPath));
  const response = await fetch(options.endpoint ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT, {
    method: 'POST',
    headers: {
      ...agentDeviceRequestHeaders(),
      Authorization: basicAuthHeader(options),
    },
    body: form,
  });
  const json = (await response.json()) as unknown;
  const appUrl = readBrowserStackAppUrl(json);
  if (!response.ok || !appUrl) {
    throw new AppError('COMMAND_FAILED', 'BrowserStack app upload failed.', {
      status: response.status,
      response: json,
    });
  }
  return appUrl;
}

export function createBrowserStackUploadApp(
  options: Required<BrowserStackUploadOptions>,
): CloudWebDriverUploadApp {
  return async ({ appPath, options: installOptions }) => {
    const appReference = await uploadBrowserStackApp(appPath, options);
    return {
      appReference,
      bundleId: installOptions?.appIdentifierHint,
      packageName: installOptions?.packageNameHint,
      launchTarget: installOptions?.appIdentifierHint ?? installOptions?.packageNameHint,
    };
  };
}

export function buildBrowserStackCapabilities(
  options: BrowserStackCapabilitiesOptions,
): Record<string, unknown> {
  return {
    device: options.deviceName,
    os_version: options.osVersion,
    ...(options.app ? { app: options.app } : {}),
    'bstack:options': {
      ...(options.projectName ? { projectName: options.projectName } : {}),
      buildName: options.buildName,
      sessionName: options.sessionName,
    },
    ...(options.configured ?? {}),
  };
}

function resolveConfiguredBrowserStackCapabilities(
  options: BrowserStackWebDriverRuntimeOptions,
  lease: DeviceLease,
): Record<string, unknown> {
  return typeof options.webdriverCapabilities === 'function'
    ? options.webdriverCapabilities(lease)
    : (options.webdriverCapabilities ?? {});
}

async function fetchBrowserStackSessionDetails(
  sessionId: string,
  options: BrowserStackSessionDetailsOptions,
): Promise<Record<string, unknown>> {
  const endpoint = new URL(
    `${trimTrailingSlash(String(options.endpoint ?? BROWSERSTACK_SESSION_DETAILS_ENDPOINT))}/${sessionId}.json`,
  );
  const response = await fetch(endpoint, {
    headers: {
      ...agentDeviceRequestHeaders(),
      Authorization: basicAuthHeader(options),
    },
  });
  const json = (await response.json()) as unknown;
  if (!response.ok || !json || typeof json !== 'object') {
    throw new AppError('COMMAND_FAILED', 'BrowserStack session details lookup failed.', {
      status: response.status,
      response: json,
    });
  }
  const details = (json as { automation_session?: unknown }).automation_session ?? json;
  return details && typeof details === 'object' ? (details as Record<string, unknown>) : {};
}

function mapBrowserStackArtifacts(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
): CloudArtifact[] {
  return [
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'video_url',
      'video',
      'Session video',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'appium_logs_url',
      'appium-log',
      'Appium logs',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'device_logs_url',
      'device-log',
      'Device logs',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'browser_url',
      'provider-session',
      'BrowserStack dashboard',
    ),
    browserStackUrlArtifact(
      provider,
      providerSessionId,
      details,
      'public_url',
      'provider-session',
      'Public session link',
    ),
  ].filter((artifact): artifact is CloudArtifact => artifact !== undefined);
}

function browserStackUrlArtifact(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
  field: string,
  kind: CloudArtifact['kind'],
  name: string,
): CloudArtifact | undefined {
  const url = details[field];
  if (typeof url !== 'string' || url.length === 0) return undefined;
  return { provider, providerSessionId, kind, name, url, availability: 'ready' };
}

function readBrowserStackAppUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const appUrl = (value as { app_url?: unknown }).app_url;
  return typeof appUrl === 'string' ? appUrl : undefined;
}
