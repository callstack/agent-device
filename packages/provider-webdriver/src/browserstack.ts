import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { ProviderProfileFieldDeclaration } from '@agent-device/contracts/provider-profile-fields';
import { setTimeout as sleep } from 'node:timers/promises';
import { AppError } from '@agent-device/kernel/errors';
import type { CloudWebDriverCapabilityOverrides } from './capabilities.ts';
import type { CloudWebDriverUploadApp } from './runtime.ts';
import { cloudArtifactsReadyOrPending, urlArtifactFromDetails } from './artifact-results.ts';
import {
  BROWSERSTACK_CREDENTIAL_VARIABLES,
  canonicalBrowserStackAppReference,
  CLOUD_WEBDRIVER_PROVIDERS,
  isBrowserStackAppReference,
} from './providers.ts';
import {
  appendUrlPath,
  appFileUploadForm,
  createHubUploadApp,
  fetchProviderResponseStatus,
  fetchProviderSessionDetails,
  postHubAppUpload,
  requireEnv,
  resolveHubAppReference,
} from './webdriver-utils.ts';

export const BROWSERSTACK_PROFILE_FIELDS: ProviderProfileFieldDeclaration = {
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
    providerNetworkLogs: 'consumed',
    awsProjectArn: 'refused',
    awsDeviceArn: 'refused',
    awsAppArn: 'refused',
    awsRegion: 'refused',
    awsInteractionMode: 'refused',
  },
};

/** The BrowserStack credentials in `env`; `consumer` names the command a missing one fails. */
export function requireBrowserStackCredentials(
  env: Readonly<Record<string, string | undefined>>,
  consumer: string,
): { username: string; accessKey: string } {
  return {
    username: requireEnv(env, BROWSERSTACK_CREDENTIAL_VARIABLES.username, consumer),
    accessKey: requireEnv(env, BROWSERSTACK_CREDENTIAL_VARIABLES.accessKey, consumer),
  };
}

export const BROWSERSTACK_APP_AUTOMATE_ENDPOINT = 'https://hub-cloud.browserstack.com/wd/hub/';
export const BROWSERSTACK_APP_UPLOAD_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/upload';
const BROWSERSTACK_SESSION_DETAILS_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/sessions';
/**
 * Measured on a live session: the HAR is absent for 20 s after the session ends and present at 30 s.
 * The window stays well inside the `lease_release` envelope, which is what runs this listing.
 */
const BROWSERSTACK_NETWORK_LOG_WAIT_MS = 30_000;
const NETWORK_LOG_POLL_INTERVAL_MS = 5_000;
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
  options: BrowserStackSessionDetailsOptions & {
    /** Requested with `--provider-network-logs`: also look for the post-session HAR. */
    networkLogs?: boolean;
    /** The session is closed, so the HAR may still be publishing: wait briefly for it. */
    sessionEnded?: boolean;
    /** Overrides the publication wait; the default is the measured BrowserStack window. */
    networkLogRetry?: Readonly<{ waitMs: number; pollMs: number }>;
  },
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  const details = await fetchBrowserStackSessionDetails(providerSessionId, options);
  const artifacts = mapBrowserStackArtifacts(provider, providerSessionId, details);
  if (options.networkLogs && options.sessionEnded) {
    const har = await fetchBrowserStackNetworkLogArtifact(provider, providerSessionId, details, {
      ...options,
      networkLogRetry: options.networkLogRetry ?? {
        waitMs: BROWSERSTACK_NETWORK_LOG_WAIT_MS,
        pollMs: NETWORK_LOG_POLL_INTERVAL_MS,
      },
    });
    if (har) artifacts.push(har);
  }
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
    await appFileUploadForm(appPath, 'file', {
      provider: CLOUD_WEBDRIVER_PROVIDERS.browserStack,
      service: 'BrowserStack',
    }),
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

/**
 * The canonical `bs://` reference for `app`, or undefined when `app` does not use the scheme. A
 * `bs://` value outside the id grammar is `INVALID_ARGS`, worded the same on every path.
 */
export function parseBrowserStackAppReference(app: string): string | undefined {
  const reference = canonicalBrowserStackAppReference(app);
  if (reference === undefined || isBrowserStackAppReference(reference)) return reference;
  throw new AppError('INVALID_ARGS', `BrowserStack --provider-app ${app} is not a bs:// app id.`, {
    providerApp: app,
    hint: 'Pass <bs://app-id-or-local-path>.',
  });
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
    referenceLabel: 'a bs:// app id',
    parseReference: parseBrowserStackAppReference,
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
      ...asRecord(configuredBstackOptions),
    },
  };
}

/**
 * The HAR endpoint sits under `builds/<build>/sessions/`, while the details endpoint the profile
 * configures is `.../app-automate/sessions`. Both share one API origin, so the HAR path is rebuilt
 * from that origin and an endpoint override keeps pointing at the same API.
 */
function networkLogsEndpoint(
  endpoint: string | URL | undefined,
  buildId: string,
  providerSessionId: string,
): string {
  const apiOrigin = new URL(appendUrlPath(endpoint ?? BROWSERSTACK_SESSION_DETAILS_ENDPOINT, ''))
    .origin;
  return appendUrlPath(
    `${apiOrigin}/app-automate/builds`,
    `${encodeURIComponent(buildId)}/sessions/${encodeURIComponent(providerSessionId)}/networklogs`,
  ).toString();
}

async function readNetworkLogsStatus(
  endpoint: string,
  options: BrowserStackSessionDetailsOptions,
): Promise<number> {
  return await fetchProviderResponseStatus(endpoint, {
    clientVersion: options.clientVersion,
    auth: options,
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
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
  return asRecord(json.automation_session ?? json);
}

/**
 * Reads the post-session HAR through its API path.
 *
 * The API answers 404 while the HAR is still being published, so only that status waits. A 400
 * reports a standing property of the session: BrowserStack's capture is a proxy the app must trust,
 * so an app without the mitmproxy CA in its trust store is never captured. That case is an
 * unavailable artifact with the reason, not a failed lookup.
 */
async function fetchBrowserStackNetworkLogArtifact(
  provider: string,
  providerSessionId: string,
  details: Record<string, unknown>,
  options: BrowserStackSessionDetailsOptions & {
    networkLogRetry: Readonly<{ waitMs: number; pollMs: number }>;
  },
): Promise<CloudArtifact | undefined> {
  const buildId = details.build_hashed_id;
  if (typeof buildId !== 'string' || buildId.length === 0) return undefined;
  const endpoint = networkLogsEndpoint(options.endpoint, buildId, providerSessionId);
  const deadline = Date.now() + options.networkLogRetry.waitMs;
  for (;;) {
    const status = await readNetworkLogsStatus(endpoint, options);
    if (status === 200) {
      return {
        provider,
        providerSessionId,
        kind: 'network',
        name: 'Network traffic (HAR)',
        url: endpoint,
        extension: 'har',
        availability: 'ready',
      };
    }
    if (status === 400) {
      return {
        provider,
        providerSessionId,
        kind: 'network',
        name: 'Network traffic (HAR)',
        extension: 'har',
        availability: 'unavailable',
        metadata: {
          reason: 'network-logs-not-captured',
          hint: 'BrowserStack captures traffic through a proxy the app must trust. Add the mitmproxy CA to a debuggable app, or exclude pinned hosts.',
        },
      };
    }
    if (status !== 404) {
      throw new AppError(
        'COMMAND_FAILED',
        `BrowserStack network log lookup failed with status ${String(status)}.`,
        { providerSessionId, hint: 'Retry artifacts for this session, then check the dashboard.' },
      );
    }
    if (Date.now() >= deadline) return undefined;
    await sleep(options.networkLogRetry.pollMs);
  }
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
