import path from 'node:path';
import type { CloudArtifact, CloudArtifactsResult } from '@agent-device/contracts/observability';
import type { ProviderDeviceOrientation } from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { asOptionalRecord } from '@agent-device/kernel/record';
import {
  appendUrlPath,
  appFileUploadForm,
  createHubUploadApp,
  postHubAppUpload,
  requireProviderDeviceOrientation,
  resolveHubAppReference,
  urlArtifactFromDetails,
  type CloudWebDriverPlatform,
  type CloudWebDriverUploadApp,
} from '@agent-device/provider-webdriver/plugin';
import {
  isSauceLabsAppUrl,
  parseSauceLabsAppReference,
  SAUCE_LABS_PROVIDER,
  SAUCE_LABS_REASONS,
  SAUCE_LABS_SERVICE,
  sauceLabsApiEndpoint,
  sauceLabsDashboardUrl,
  type SauceLabsCredentials,
  type SauceLabsRegion,
} from './providers.ts';

export const SAUCE_LABS_CAPABILITY_OVERRIDES = {
  install: {
    support: 'partial',
    note: 'Local app artifacts are uploaded to Sauce Labs app storage, then installed with Appium.',
  },
  portReverse: {
    support: 'unsupported',
    note: 'agent-device port reverse is not available on Sauce Labs real devices.',
  },
  artifacts: {
    support: 'supported',
    note: 'Sauce Labs real-device jobs expose the dashboard link at once, then video, Appium, device, and request logs once the job ends.',
  },
} as const;

/** The Sauce Labs session options a connect profile carries beside device, OS, and app. */
export type SauceLabsSessionFields = {
  providerDeviceOrientation?: ProviderDeviceOrientation;
  providerAppiumVersion?: string;
  providerNoResignApp?: boolean;
};

/** Reads the session options off an untyped flag bag, so connect and the daemon validate them alike. */
export function readSauceLabsSessionFields(
  flags: Record<string, unknown> | undefined,
  platform: CloudWebDriverPlatform,
): SauceLabsSessionFields {
  const orientation = flags?.providerDeviceOrientation;
  const appiumVersion = flags?.providerAppiumVersion;
  const noResignApp = flags?.providerNoResignApp === true;
  if (noResignApp && platform !== 'ios') {
    throw new AppError(
      'INVALID_ARGS',
      `--provider-no-resign-app applies to ios sessions only, but the session platform is ${platform}.`,
      {
        reason: SAUCE_LABS_REASONS.noResignAppIosOnly.reason,
        flag: '--provider-no-resign-app',
        platform,
        hint: 'Drop --provider-no-resign-app or connect with --platform ios.',
      },
    );
  }
  return {
    ...(typeof orientation === 'string' && orientation.length > 0
      ? {
          providerDeviceOrientation: requireProviderDeviceOrientation(
            { flag: '--provider-device-orientation', capability: 'appium:orientation' },
            orientation,
          ),
        }
      : {}),
    ...(typeof appiumVersion === 'string' && appiumVersion.length > 0
      ? { providerAppiumVersion: appiumVersion }
      : {}),
    ...(noResignApp ? { providerNoResignApp: true } : {}),
  };
}

export type SauceLabsApiOptions = SauceLabsCredentials & {
  clientVersion: string;
  region: SauceLabsRegion;
};

/** Uploads a local app to the region's storage; the `name` field keeps the file name Sauce shows. */
async function uploadSauceLabsApp(
  appPath: string,
  options: SauceLabsApiOptions,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const form = await appFileUploadForm(appPath, 'payload', {
    provider: SAUCE_LABS_PROVIDER,
    service: SAUCE_LABS_SERVICE,
  });
  form.set('name', path.basename(appPath));
  const fileId = await postHubAppUpload(
    form,
    {
      service: SAUCE_LABS_SERVICE,
      endpoint: appendUrlPath(sauceLabsApiEndpoint(options.region), 'v1/storage/upload'),
      clientVersion: options.clientVersion,
      auth: options,
      readAppReference: (body) => {
        const id = asOptionalRecord(asOptionalRecord(body)?.item)?.id;
        return typeof id === 'string' ? id : undefined;
      },
    },
    signal,
  );
  return `storage:${fileId}`;
}

export function createSauceLabsUploadApp(options: SauceLabsApiOptions): CloudWebDriverUploadApp {
  return createHubUploadApp(
    async (appPath, signal) => await uploadSauceLabsApp(appPath, options, signal),
  );
}

/** A `storage:` reference passes through, an https URL is fetched by Sauce, and a local path is uploaded. */
export async function resolveSauceLabsAppReference(
  app: string,
  options: SauceLabsApiOptions & { cwd?: string; signal?: AbortSignal },
): Promise<string> {
  return await resolveHubAppReference({
    service: SAUCE_LABS_SERVICE,
    app,
    cwd: options.cwd,
    referenceLabel: 'a storage: reference',
    parseReference: (value) => {
      const reference = parseSauceLabsAppReference(value)?.reference;
      if (reference !== undefined) return reference;
      return isSauceLabsAppUrl(value) ? value : undefined;
    },
    uploadFile: async (appPath, signal) => await uploadSauceLabsApp(appPath, options, signal),
    signal: options.signal,
  });
}

export type SauceLabsCapabilitiesOptions = SauceLabsSessionFields & {
  platform: CloudWebDriverPlatform;
  deviceName: string;
  osVersion?: string;
  app: string;
  buildName: string;
  sessionName: string;
  /** The base W3C capabilities (`platformName`, `appium:deviceName`); the keys below win over them. */
  base: Record<string, unknown>;
};

/**
 * Sauce Labs closes a real-device session after this many idle seconds, and refuses a larger value.
 * Its default of 60 is shorter than an agent often thinks between two commands.
 */
const SAUCE_LABS_REAL_DEVICE_MAX_NEW_COMMAND_TIMEOUT_S = 90;

/**
 * How long Sauce Labs may look for a free device. The client gives the whole create, app install
 * included, 180 seconds; a queue that outlived it would rent a device nobody waits for.
 */
export const SAUCE_LABS_SESSION_CREATION_TIMEOUT_MS = 100_000;

/**
 * Builds the W3C `alwaysMatch` capabilities for a Sauce Labs Real Device Cloud session. Appium keys
 * are `appium:`-prefixed; Sauce's own labels, server selection, and queueing live in `sauce:options`.
 */
export function buildSauceLabsCapabilities(
  options: SauceLabsCapabilitiesOptions,
): Record<string, unknown> {
  return {
    ...options.base,
    'appium:deviceName': options.deviceName,
    ...(options.osVersion ? { 'appium:platformVersion': options.osVersion } : {}),
    // Appium 2 and later refuse a session that names no driver.
    'appium:automationName': options.platform === 'ios' ? 'XCUITest' : 'UiAutomator2',
    'appium:app': options.app,
    'appium:newCommandTimeout': SAUCE_LABS_REAL_DEVICE_MAX_NEW_COMMAND_TIMEOUT_S,
    ...(options.providerDeviceOrientation
      ? { 'appium:orientation': options.providerDeviceOrientation.toUpperCase() }
      : {}),
    'sauce:options': {
      name: options.sessionName,
      build: options.buildName,
      // The interactor's `mobile:` commands need an Appium 2 or later server.
      appiumVersion: options.providerAppiumVersion ?? 'latest',
      sessionCreationTimeout: SAUCE_LABS_SESSION_CREATION_TIMEOUT_MS,
      // A retry would start another device search after the client stopped waiting.
      sessionCreationRetry: 0,
      ...(options.providerNoResignApp ? { resigningEnabled: false } : {}),
    },
  };
}

const SAUCE_LABS_JOB_ID = /^[0-9a-f]{32}$/i;

/**
 * What a Sauce Labs hub reports about the session it created: the real-device job id that job
 * details, media, and the dashboard are keyed by, and the device it actually allocated, as its
 * model name and Sauce device id.
 */
export function describeSauceLabsSession(capabilities: Record<string, unknown>): {
  providerSessionId?: string;
  model?: string;
} {
  const name =
    readString(capabilities, 'testobject_device_name') ?? readString(capabilities, 'deviceModel');
  const descriptor = readString(capabilities, 'testobject_device');
  const model = name && descriptor ? `${name} (${descriptor})` : (name ?? descriptor);
  return {
    providerSessionId: readSauceLabsJobId(capabilities),
    ...(model ? { model } : {}),
  };
}

function readSauceLabsJobId(capabilities: Record<string, unknown>): string | undefined {
  for (const key of ['jobUuid', 'appium:jobUuid']) {
    const value = readString(capabilities, key);
    if (value && SAUCE_LABS_JOB_ID.test(value)) return value;
  }
  for (const key of [
    'testobject_test_report_api_url',
    'testobject_test_report_url',
    'appium:testobject_test_report_api_url',
    'appium:testobject_test_report_url',
  ]) {
    const value = readString(capabilities, key);
    const id = value?.split(/[?#]/)[0]?.replace(/\/+$/, '').split('/').pop();
    if (id && SAUCE_LABS_JOB_ID.test(id)) return id;
  }
  return undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

/** Job states after which Sauce Labs adds no more media or logs. */
const SAUCE_LABS_FINAL_JOB_STATES = new Set(['complete', 'passed', 'failed', 'error']);

const PROVIDER_API_TIMEOUT_MS = 15_000;

/**
 * The provider-hosted artifacts of one real-device job. The dashboard link is ready as soon as the
 * job id is known; video and logs are listed once the job reaches a final state. A session the hub
 * created without reporting a job id answers `unavailable` rather than guessing at another id.
 */
export async function listSauceLabsCloudArtifacts(
  provider: string,
  providerSessionId: string | undefined,
  options: SauceLabsApiOptions,
): Promise<CloudArtifactsResult | undefined> {
  if (!providerSessionId) return undefined;
  if (!SAUCE_LABS_JOB_ID.test(providerSessionId)) {
    return {
      provider,
      providerSessionId,
      status: 'unavailable',
      cloudArtifacts: [],
      message: `Sauce Labs reported no real-device job id for session ${providerSessionId}, so its artifacts cannot be looked up. Find the job in the Sauce Labs dashboard.`,
    };
  }
  const job = await fetchSauceLabsJob(providerSessionId, options);
  const dashboard: CloudArtifact = {
    provider,
    providerSessionId,
    kind: 'provider-session',
    name: 'Sauce Labs dashboard',
    url: sauceLabsDashboardUrl(options.region, providerSessionId),
    availability: 'ready',
  };
  const state = typeof job.status === 'string' ? job.status.toLowerCase() : '';
  if (!SAUCE_LABS_FINAL_JOB_STATES.has(state)) {
    return {
      provider,
      providerSessionId,
      status: 'pending',
      cloudArtifacts: [dashboard],
      message: 'The Sauce Labs job has not ended yet; video and logs follow once it does.',
    };
  }
  return {
    provider,
    providerSessionId,
    status: 'ready',
    cloudArtifacts: [...mapSauceLabsJobArtifacts(provider, providerSessionId, job), dashboard],
  };
}

function mapSauceLabsJobArtifacts(
  provider: string,
  providerSessionId: string,
  job: Record<string, unknown>,
): CloudArtifact[] {
  const fields: Array<[string, CloudArtifact['kind'], string]> = [
    ['video_url', 'video', 'Session video'],
    ['framework_log_url', 'appium-log', 'Appium logs'],
    ['device_log_url', 'device-log', 'Device logs'],
    ['requests_url', 'automation-log', 'WebDriver requests'],
    ['crash_log_url', 'device-log', 'Crash logs'],
    ['network_log_url', 'network', 'Network logs'],
  ];
  return fields
    .map(([field, kind, name]) =>
      urlArtifactFromDetails(provider, providerSessionId, job, field, kind, name),
    )
    .filter((artifact): artifact is CloudArtifact => artifact !== undefined);
}

/**
 * Reads one real-device job. Rejected credentials are `UNAUTHORIZED` and a job the region does not
 * know is a typed not-found, so neither reads as artifacts still being processed.
 */
async function fetchSauceLabsJob(
  jobId: string,
  options: SauceLabsApiOptions,
): Promise<Record<string, unknown>> {
  const endpoint = appendUrlPath(
    sauceLabsApiEndpoint(options.region),
    `v1/rdc/jobs/${encodeURIComponent(jobId)}`,
  );
  let response: Response;
  let text: string;
  try {
    response = await fetch(endpoint, {
      headers: {
        'User-Agent': `agent-device/${options.clientVersion}`,
        Authorization: `Basic ${Buffer.from(`${options.username}:${options.accessKey}`).toString('base64')}`,
      },
      signal: AbortSignal.timeout(PROVIDER_API_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'Sauce Labs job lookup failed.',
      { hint: `Check network access to api.${options.region}.saucelabs.com, then retry.` },
      error,
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError('UNAUTHORIZED', 'Sauce Labs rejected the job lookup credentials.', {
      status: response.status,
      hint: 'Check SAUCE_USERNAME and SAUCE_ACCESS_KEY.',
    });
  }
  if (response.status === 404) {
    throw new AppError(
      'INVALID_ARGS',
      `Sauce Labs has no real-device job ${jobId} in ${options.region}.`,
      {
        reason: SAUCE_LABS_REASONS.jobNotFound.reason,
        status: 404,
        region: options.region,
        hint: 'Check the job id, and that SAUCE_REGION names the data center the job ran in.',
      },
    );
  }
  const job = asOptionalRecord(parseJson(text));
  if (!response.ok || !job) {
    throw new AppError('COMMAND_FAILED', 'Sauce Labs job lookup failed.', {
      status: response.status,
    });
  }
  return job;
}

/** A body that is empty or not JSON, such as a gateway error page, reads as no answer. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
