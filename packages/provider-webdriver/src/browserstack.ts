import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { CloudWebDriverCapabilityOverrides } from './capabilities.ts';
import type { CloudWebDriverUploadApp } from './runtime.ts';
import { cloudArtifactsReadyOrPending, urlArtifactFromDetails } from './artifact-results.ts';
import { isBrowserStackAppReference } from './providers.ts';
import {
  appendUrlPath,
  appFileUploadForm,
  asRecord,
  createHubUploadApp,
  fetchProviderSessionDetails,
  postHubAppUpload,
  resolveHubAppReference,
} from './webdriver-utils.ts';

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

export type BrowserStackCapabilitiesOptions = {
  deviceName: string;
  osVersion: string;
  app?: string;
  projectName?: string;
  buildName: string;
  sessionName: string;
  /** Vendor device-feature capabilities, already projected onto their `bstack:options` keys. */
  deviceFeatures?: Record<string, unknown>;
  configured?: Record<string, unknown>;
};

export type BrowserStackSessionDetailsOptions = {
  clientVersion: string;
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
  clientVersion: string;
  username: string;
  accessKey: string;
  endpoint?: string | URL;
};

export async function uploadBrowserStackApp(
  appPath: string,
  options: BrowserStackUploadOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  return await postHubAppUpload(
    await appFileUploadForm(appPath, 'file'),
    {
      service: 'BrowserStack',
      endpoint: options.endpoint ?? BROWSERSTACK_APP_UPLOAD_ENDPOINT,
      clientVersion: options.clientVersion,
      auth: options,
      readAppReference: readBrowserStackAppUrl,
    },
    signal,
  );
}

export function createBrowserStackUploadApp(
  options: Required<BrowserStackUploadOptions>,
): CloudWebDriverUploadApp {
  return createHubUploadApp(
    async (appPath, signal) => await uploadBrowserStackApp(appPath, options, signal),
  );
}

/** The hub fetches a public URL itself, so only a local path is uploaded. */
export async function resolveBrowserStackAppReference(
  app: string,
  options: BrowserStackUploadOptions & { cwd?: string; signal?: AbortSignal },
): Promise<string> {
  return await resolveHubAppReference({
    service: 'BrowserStack',
    app,
    cwd: options.cwd,
    referenceScheme: 'bs://',
    referenceLabel: 'a bs:// app id',
    isReference: isBrowserStackAppReference,
    uploadFile: async (appPath, signal) => await uploadBrowserStackApp(appPath, options, signal),
    signal: options.signal,
  });
}

/**
 * Builds the W3C `alwaysMatch` capabilities for a BrowserStack App Automate session.
 *
 * Every key is either W3C-standard (`platformName`), `appium:`-prefixed, or inside
 * `bstack:options`. The legacy JSON Wire keys (`device`, `os_version`, `app`, `project`, `build`,
 * `name`) must not appear: when the hub sees any of them it treats the whole request as a legacy
 * session and reads the labels from the legacy top-level keys instead of `bstack:options`, so the
 * project/build/session names are silently dropped and the session lands in "Untitled Project".
 */
export function buildBrowserStackCapabilities(
  options: BrowserStackCapabilitiesOptions,
): Record<string, unknown> {
  const { 'bstack:options': configuredBstackOptions, ...configured } = options.configured ?? {};
  return {
    'appium:deviceName': options.deviceName,
    'appium:platformVersion': options.osVersion,
    ...(options.app ? { 'appium:app': options.app } : {}),
    ...configured,
    // Merged per key, never assigned: `configured` carrying its own `bstack:options` used to
    // replace the whole object and silently drop the session/build labels below.
    'bstack:options': {
      ...(options.projectName ? { projectName: options.projectName } : {}),
      buildName: options.buildName,
      sessionName: options.sessionName,
      ...(options.deviceFeatures ?? {}),
      ...(asRecord(configuredBstackOptions) ?? {}),
    },
  };
}

async function fetchBrowserStackSessionDetails(
  sessionId: string,
  options: BrowserStackSessionDetailsOptions,
): Promise<Record<string, unknown>> {
  const endpoint = appendUrlPath(
    options.endpoint ?? BROWSERSTACK_SESSION_DETAILS_ENDPOINT,
    `${sessionId}.json`,
  );
  const json = await fetchProviderSessionDetails(endpoint, {
    clientVersion: options.clientVersion,
    auth: options,
    service: 'BrowserStack',
  });
  return asRecord(json.automation_session) ?? json;
}

function mapBrowserStackArtifacts(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
): CloudArtifact[] {
  return [
    urlArtifactFromDetails(
      provider,
      providerSessionId,
      details,
      'video_url',
      'video',
      'Session video',
    ),
    urlArtifactFromDetails(
      provider,
      providerSessionId,
      details,
      'appium_logs_url',
      'appium-log',
      'Appium logs',
    ),
    urlArtifactFromDetails(
      provider,
      providerSessionId,
      details,
      'device_logs_url',
      'device-log',
      'Device logs',
    ),
    urlArtifactFromDetails(
      provider,
      providerSessionId,
      details,
      'browser_url',
      'provider-session',
      'BrowserStack dashboard',
    ),
    urlArtifactFromDetails(
      provider,
      providerSessionId,
      details,
      'public_url',
      'provider-session',
      'Public session link',
    ),
  ].filter((artifact): artifact is CloudArtifact => artifact !== undefined);
}

function readBrowserStackAppUrl(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const appUrl = (value as { app_url?: unknown }).app_url;
  return typeof appUrl === 'string' ? appUrl : undefined;
}
