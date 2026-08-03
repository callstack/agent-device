import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { basicAuthHeader } from './webdriver-utils.ts';
import type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';
import type { ProviderConnectionResource } from '@agent-device/contracts/remote';

const BROWSERSTACK_DEVICES_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/devices.json';
const BROWSERSTACK_APPS_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/recent_apps?limit=100';

type BrowserStackOptions = Extract<
  CloudWebDriverConnectionVerificationOptions,
  { provider: 'browserstack' }
>;

export async function verifyBrowserStackConnection(
  options: BrowserStackOptions,
  clientVersion: string,
): Promise<CloudWebDriverConnectionVerification> {
  const auth = { username: options.username, accessKey: options.accessKey };
  const devices = await fetchBrowserStackJson(
    options.devicesEndpoint ?? BROWSERSTACK_DEVICES_ENDPOINT,
    auth,
    clientVersion,
  );
  const matchedDevice = readBrowserStackDevices(devices).find(
    (device) =>
      device.device === options.deviceName &&
      device.os.toLowerCase() === options.platform &&
      sameOsVersion(device.osVersion, options.osVersion),
  );
  if (!matchedDevice) {
    throw new AppError(
      'INVALID_ARGS',
      `BrowserStack device "${options.deviceName}" with ${options.platform} ${options.osVersion} is not available.`,
      {
        hint: 'Choose an exact device and OS version from the BrowserStack App Automate device list.',
      },
    );
  }

  const app = await verifyBrowserStackApp(options, auth, clientVersion);
  return {
    provider: 'browserstack',
    service: 'BrowserStack',
    verificationMessage:
      app.status === 'verified'
        ? 'Credentials, device, and uploaded app verified.'
        : 'Credentials and device access verified; app availability is checked when the session is created.',
    device: {
      status: 'verified',
      name: matchedDevice.device,
      platform: options.platform,
      osVersion: matchedDevice.osVersion,
    },
    app,
  };
}

async function verifyBrowserStackApp(
  options: BrowserStackOptions,
  auth: { username: string; accessKey: string },
  clientVersion: string,
): Promise<ProviderConnectionResource> {
  const { app } = options;
  if (app.startsWith('bs://')) {
    const apps = await fetchBrowserStackJson(
      options.appsEndpoint ?? BROWSERSTACK_APPS_ENDPOINT,
      auth,
      clientVersion,
    );
    const matched = readBrowserStackApps(apps).find((entry) => entry.reference === app);
    if (!matched) {
      return {
        status: 'configured',
        reference: app,
        message:
          'App reference was not found in the 100 most recent uploads; BrowserStack validates it when creating the session.',
      };
    }
    return { status: 'verified', ...matched };
  }
  if (/^https?:\/\//i.test(app)) {
    return {
      status: 'configured',
      reference: app,
      message: 'Public app URL configured; BrowserStack validates it when creating the session.',
    };
  }
  return {
    status: 'configured',
    name: path.basename(app),
    reference: app,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

async function fetchBrowserStackJson(
  endpoint: string | URL,
  auth: { username: string; accessKey: string },
  clientVersion: string,
): Promise<unknown> {
  try {
    const response = await fetch(endpoint, {
      headers: {
        ...agentDeviceRequestHeaders(clientVersion),
        Authorization: basicAuthHeader(auth),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const unauthorized = response.status === 401 || response.status === 403;
      throw new AppError(
        unauthorized ? 'UNAUTHORIZED' : 'COMMAND_FAILED',
        'BrowserStack rejected connection verification.',
        {
          status: response.status,
          hint: unauthorized
            ? 'Check BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY.'
            : 'Retry connect or check the BrowserStack service status.',
        },
      );
    }
    return (await response.json()) as unknown;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(
      'COMMAND_FAILED',
      'BrowserStack connection verification failed.',
      { hint: 'Check network access to api-cloud.browserstack.com and retry connect.' },
      error,
    );
  }
}

function sameOsVersion(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(?:\.0)+$/, '');
  return normalize(left) === normalize(right);
}

function readBrowserStackDevices(
  value: unknown,
): Array<{ device: string; os: string; osVersion: string }> {
  if (!Array.isArray(value)) {
    throw new AppError(
      'COMMAND_FAILED',
      'BrowserStack device verification response was not a list.',
    );
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const osVersion = record?.os_version;
    return record &&
      typeof record.device === 'string' &&
      typeof record.os === 'string' &&
      (typeof osVersion === 'string' || typeof osVersion === 'number')
      ? [{ device: record.device, os: record.os, osVersion: String(osVersion) }]
      : [];
  });
}

function readBrowserStackApps(
  value: unknown,
): Array<{ name?: string; reference: string; version?: string }> {
  const record = asRecord(value);
  if (record && Object.keys(record).length === 0) return [];
  if (!Array.isArray(value)) {
    throw new AppError('COMMAND_FAILED', 'BrowserStack app verification response was not a list.');
  }
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    if (!record || typeof record.app_url !== 'string') return [];
    return [
      {
        reference: record.app_url,
        ...(typeof record.app_name === 'string' ? { name: record.app_name } : {}),
        ...(typeof record.app_version === 'string' ? { version: record.app_version } : {}),
      },
    ];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
