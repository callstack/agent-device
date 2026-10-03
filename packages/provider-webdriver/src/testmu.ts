import fs from 'node:fs/promises';
import path from 'node:path';
import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { ProviderDeviceType } from '@agent-device/contracts/remote';
import type { CloudWebDriverPlatform, CloudWebDriverUploadApp } from './runtime.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isTestMuAppReference } from './providers.ts';
import { cloudArtifactsReadyOrPending, urlArtifactFromDetails } from './artifact-results.ts';
import {
  appendUrlPath,
  appFileUploadForm,
  asRecord,
  createHubUploadApp,
  fetchProviderSessionDetails,
  postHubAppUpload,
  resolveHubAppReference,
} from './webdriver-utils.ts';

/**
 * TestMu session, upload, and artifact mechanics. Loaded on demand by the provider definition;
 * `isRealMobile` in `lt:options` is what routes a session to the real or virtual device pool, and
 * the hostnames still carry the lambdatest.com brand.
 */
const TESTMU_APP_UPLOAD_ENDPOINTS: Record<ProviderDeviceType, string> = {
  real: 'https://manual-api.lambdatest.com/app/upload/realDevice',
  virtual: 'https://manual-api.lambdatest.com/app/upload/virtualDevice',
};
export const TESTMU_APPS_ENDPOINT = 'https://manual-api.lambdatest.com/app/data';
export const TESTMU_API_ENDPOINT = 'https://mobile-api.lambdatest.com/mobile-automation/api/v1';
export { isTestMuAppReference };

const TESTMU_DASHBOARD_TEST_URL = 'https://appautomation.lambdatest.com/test?testID=';

export type TestMuCapabilitiesOptions = {
  platform: CloudWebDriverPlatform;
  /** Defaults to `virtual`. */
  deviceType?: ProviderDeviceType;
  deviceName: string;
  osVersion: string;
  app?: string;
  projectName?: string;
  buildName: string;
  sessionName: string;
  /** Vendor device-feature capabilities, already projected onto their `lt:options` keys. */
  deviceFeatures?: Record<string, unknown>;
  configured?: Record<string, unknown>;
};

export type TestMuAuth = {
  username: string;
  accessKey: string;
};

export type TestMuSessionDetailsOptions = TestMuAuth & {
  clientVersion: string;
  endpoint?: string | URL;
};

export async function listTestMuCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  options: TestMuSessionDetailsOptions,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const details = await fetchTestMuSessionDetails(providerSessionId, options);
  const artifacts = mapTestMuArtifacts(provider, providerSessionId, details);
  return cloudArtifactsReadyOrPending({
    provider,
    providerSessionId,
    artifacts,
    pendingMessage: 'TestMu AI artifacts are not ready yet.',
  });
}

export type TestMuUploadOptions = TestMuAuth & {
  clientVersion: string;
  /** Selects the pool's upload API when no endpoint override is given; defaults to `virtual`. */
  deviceType?: ProviderDeviceType;
  endpoint?: string | URL;
};

/** Uploads a local `.apk`, `.aab`, `.ipa`, or zipped simulator `.app` and returns its `lt://` reference. */
export async function uploadTestMuApp(
  appPath: string,
  options: TestMuUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  // A missing path is the same caller mistake as a directory, so both get the typed refusal.
  const stat = await fs.stat(appPath).catch(() => undefined);
  if (!stat?.isFile()) {
    throw new AppError('INVALID_ARGS', `TestMu AI can only upload an app file: ${appPath}`, {
      appPath,
      hint:
        options.deviceType === 'real'
          ? 'Real iOS devices install a signed .ipa; pass the .ipa file.'
          : 'Zip the .app bundle of an iOS simulator build and pass the .zip.',
    });
  }
  const form = await appFileUploadForm(appPath, 'appFile');
  form.set('name', path.parse(appPath).name);
  return await postTestMuUpload(form, options, signal);
}

/** Has TestMu fetch a public app URL itself, returning its `lt://` reference. */
export async function uploadTestMuAppFromUrl(
  url: string,
  options: TestMuUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const form = new FormData();
  form.set('url', url);
  form.set('storage', 'url');
  form.set('name', path.basename(new URL(url).pathname) || 'app');
  return await postTestMuUpload(form, options, signal);
}

async function postTestMuUpload(
  form: FormData,
  options: TestMuUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  return await postHubAppUpload(
    form,
    {
      service: 'TestMu AI',
      endpoint: options.endpoint ?? TESTMU_APP_UPLOAD_ENDPOINTS[options.deviceType ?? 'virtual'],
      clientVersion: options.clientVersion,
      auth: options,
      readAppReference: readTestMuAppReference,
    },
    signal,
  );
}

export function createTestMuUploadApp(options: TestMuUploadOptions): CloudWebDriverUploadApp {
  return createHubUploadApp(
    async (appPath, signal) => await uploadTestMuApp(appPath, options, signal),
  );
}

/** The hub only accepts `lt://` references, so a public URL is handed to the upload API to fetch. */
export async function resolveTestMuAppReference(
  app: string,
  options: TestMuUploadOptions & { cwd?: string; signal?: AbortSignal },
): Promise<string> {
  return await resolveHubAppReference({
    service: 'TestMu AI',
    app,
    cwd: options.cwd,
    referenceScheme: 'lt://',
    referenceLabel: 'an lt:// app id',
    isReference: isTestMuAppReference,
    uploadFile: async (appPath, signal) => await uploadTestMuApp(appPath, options, signal),
    uploadUrl: async (url, signal) => await uploadTestMuAppFromUrl(url, options, signal),
    signal: options.signal,
  });
}

/**
 * Builds the W3C `alwaysMatch` capabilities for a TestMu session.
 *
 * Standard Appium keys stay `appium:`-prefixed at the top level; everything TestMu-specific lives
 * in `lt:options`. `isRealMobile` selects a real device or an emulator/simulator, and `w3c: true`
 * keeps the hub on the W3C dialect agent-device speaks. `appiumVersion` is sent only when the caller
 * pins one; otherwise TestMu AI starts its default server for the device.
 */
export function buildTestMuCapabilities(
  options: TestMuCapabilitiesOptions,
): Record<string, unknown> {
  const { 'lt:options': configuredLtOptions, ...configured } = options.configured ?? {};
  const deviceFeatures = options.deviceFeatures ?? {};
  return {
    'appium:deviceName': options.deviceName,
    'appium:platformVersion': options.osVersion,
    ...(options.app ? { 'appium:app': options.app } : {}),
    ...configured,
    // Merged per key, never assigned: a configured `lt:options` must not drop the labels below.
    'lt:options': {
      platformName: options.platform === 'ios' ? 'iOS' : 'Android',
      deviceName: options.deviceName,
      platformVersion: options.osVersion,
      ...(options.app ? { app: options.app } : {}),
      ...(options.projectName ? { project: options.projectName } : {}),
      build: options.buildName,
      name: options.sessionName,
      video: true,
      devicelog: true,
      ...deviceFeatures,
      ...(asRecord(configuredLtOptions) ?? {}),
      // A configured value cannot switch the device pool or drop the W3C dialect agent-device speaks.
      isRealMobile: options.deviceType === 'real',
      w3c: true,
    },
  };
}

/** The upload and app-list APIs answer with a bare app id or an `lt://` reference. */
export function testMuAppReferenceFromId(id: string): string {
  return id.startsWith('lt://') ? id : `lt://${id}`;
}

async function fetchTestMuSessionDetails(
  sessionId: string,
  options: TestMuSessionDetailsOptions,
): Promise<Record<string, unknown>> {
  const endpoint = appendUrlPath(
    options.endpoint ?? TESTMU_API_ENDPOINT,
    `sessions/${encodeURIComponent(sessionId)}`,
  );
  let json: Record<string, unknown>;
  try {
    json = await fetchProviderSessionDetails(endpoint, {
      clientVersion: options.clientVersion,
      auth: options,
      service: 'TestMu AI',
    });
  } catch (error) {
    // Details are published a little after the session ends; until then the API answers 404.
    if (error instanceof AppError && error.details?.status === 404) return {};
    throw error;
  }
  // The API wraps the session in a jsend envelope: `{ status, data: {...}, message }`.
  const details = asRecord(json.data);
  if (!details) {
    throw new AppError('COMMAND_FAILED', 'TestMu AI session details response had no data.', {
      response: json,
    });
  }
  return details;
}

function mapTestMuArtifacts(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
): CloudArtifact[] {
  // Virtual-device sessions report the device log as `console_logs_url`.
  const deviceLogField =
    typeof details.console_logs_url === 'string' && details.console_logs_url.length > 0
      ? 'console_logs_url'
      : 'device_logs_url';
  const fromDetails = (
    [
      ['video_url', 'video', 'Session video'],
      ['appium_logs_url', 'appium-log', 'Appium logs'],
      [deviceLogField, 'device-log', 'Device logs'],
      ['network_logs_url', 'raw', 'Network logs'],
      ['command_logs_url', 'automation-log', 'Command logs'],
      ['screenshot_url', 'raw', 'Screenshots'],
    ] as const
  ).map(([field, kind, name]) =>
    urlArtifactFromDetails(provider, providerSessionId, details, field, kind, name),
  );
  const dashboard: CloudArtifact = {
    provider,
    providerSessionId,
    kind: 'provider-session',
    name: 'TestMu AI dashboard',
    url: `${TESTMU_DASHBOARD_TEST_URL}${encodeURIComponent(providerSessionId)}`,
    availability: 'ready',
  };
  const ready = fromDetails.filter((artifact): artifact is CloudArtifact => artifact !== undefined);
  // The dashboard link alone does not mean the session finished uploading; keep "pending" until
  // the API reports at least one artifact URL.
  return ready.length > 0 ? [...ready, dashboard] : [];
}

/** The upload answers with `app_url` (`lt://…`) and/or a bare `app_id`; anything else is a failed upload. */
function readTestMuAppReference(value: unknown): string | undefined {
  const { app_url: appUrl, app_id: appId } = asRecord(value) ?? {};
  if (typeof appUrl === 'string' && isTestMuAppReference(appUrl)) return appUrl;
  if (typeof appId !== 'string') return undefined;
  const reference = testMuAppReferenceFromId(appId);
  return isTestMuAppReference(reference) ? reference : undefined;
}
