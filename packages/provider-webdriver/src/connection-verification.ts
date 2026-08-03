import fs from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { ProviderWebDriverDependencies } from './dependencies.ts';
import { agentDeviceRequestHeaders } from './request-headers.ts';
import { basicAuthHeader } from './webdriver-utils.ts';

const BROWSERSTACK_DEVICES_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/devices.json';
const BROWSERSTACK_APPS_ENDPOINT =
  'https://api-cloud.browserstack.com/app-automate/recent_apps?limit=100';

export type VerifiedProviderResource = {
  status: 'verified' | 'configured' | 'deferred' | 'missing';
  name?: string;
  reference?: string;
  platform?: 'android' | 'ios';
  osVersion?: string;
  version?: string;
  availability?: string;
  message?: string;
};

export type CloudWebDriverConnectionVerification =
  | {
      provider: 'browserstack';
      service: 'BrowserStack';
      verificationMessage: string;
      device: VerifiedProviderResource;
      app: VerifiedProviderResource;
    }
  | {
      provider: 'aws-device-farm';
      service: 'AWS Device Farm';
      verificationMessage: string;
      project: { name?: string; reference: string };
      device: VerifiedProviderResource;
      app: VerifiedProviderResource;
    };

export type CloudWebDriverConnectionVerificationOptions =
  | {
      provider: 'browserstack';
      username: string;
      accessKey: string;
      platform: 'android' | 'ios';
      deviceName: string;
      osVersion: string;
      app: string;
      cwd?: string;
    }
  | {
      provider: 'aws-device-farm';
      platform: 'android' | 'ios';
      projectArn: string;
      deviceArn: string;
      appArn?: string;
      region?: string;
    };

export function readAwsDeviceFarmRegionFromArn(arn: string): string | undefined {
  return /^arn:[^:]+:devicefarm:([^:]+):/.exec(arn)?.[1];
}

export async function verifyCloudWebDriverConnection(
  options: CloudWebDriverConnectionVerificationOptions,
  dependencies: ProviderWebDriverDependencies,
): Promise<CloudWebDriverConnectionVerification> {
  return options.provider === 'browserstack'
    ? await verifyBrowserStackConnection(options, dependencies.clientVersion)
    : await verifyAwsDeviceFarmConnection(options, dependencies.runHostCommand);
}

async function verifyBrowserStackConnection(
  options: Extract<CloudWebDriverConnectionVerificationOptions, { provider: 'browserstack' }>,
  clientVersion: string,
): Promise<CloudWebDriverConnectionVerification> {
  const auth = { username: options.username, accessKey: options.accessKey };
  const devices = await fetchBrowserStackJson(BROWSERSTACK_DEVICES_ENDPOINT, auth, clientVersion);
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

  const app = await verifyBrowserStackApp(options.app, auth, clientVersion, options.cwd);
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

function sameOsVersion(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/(?:\.0)+$/, '');
  return normalize(left) === normalize(right);
}

async function verifyBrowserStackApp(
  app: string,
  auth: { username: string; accessKey: string },
  clientVersion: string,
  cwd = process.cwd(),
): Promise<VerifiedProviderResource> {
  if (app.startsWith('bs://')) {
    const apps = await fetchBrowserStackJson(BROWSERSTACK_APPS_ENDPOINT, auth, clientVersion);
    const matched = readBrowserStackApps(apps).find((entry) => entry.reference === app);
    if (!matched) {
      throw new AppError('INVALID_ARGS', `BrowserStack app "${app}" was not found.`, {
        hint: 'Upload the app again or pass a current bs:// app reference.',
      });
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
  const resolvedPath = path.resolve(cwd, app);
  try {
    const stats = await fs.stat(resolvedPath);
    if (!stats.isFile()) throw new Error('not a file');
  } catch (error) {
    throw new AppError(
      'INVALID_ARGS',
      `BrowserStack app file not found: ${resolvedPath}`,
      undefined,
      error,
    );
  }
  return {
    status: 'configured',
    name: path.basename(resolvedPath),
    reference: resolvedPath,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

async function fetchBrowserStackJson(
  endpoint: string,
  auth: { username: string; accessKey: string },
  clientVersion: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        ...agentDeviceRequestHeaders(clientVersion),
        Authorization: basicAuthHeader(auth),
      },
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'BrowserStack connection verification failed.',
      { hint: 'Check network access to api-cloud.browserstack.com and retry connect.' },
      error,
    );
  }
  if (!response.ok) {
    const code =
      response.status === 401 || response.status === 403 ? 'UNAUTHORIZED' : 'COMMAND_FAILED';
    throw new AppError(code, 'BrowserStack rejected connection verification.', {
      status: response.status,
      hint:
        code === 'UNAUTHORIZED'
          ? 'Check BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY.'
          : 'Retry connect or check the BrowserStack service status.',
    });
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    throw new AppError(
      'COMMAND_FAILED',
      'BrowserStack returned an invalid verification response.',
      undefined,
      error,
    );
  }
}

function readBrowserStackDevices(value: unknown): Array<{
  device: string;
  os: string;
  osVersion: string;
}> {
  if (!Array.isArray(value)) {
    throw new AppError(
      'COMMAND_FAILED',
      'BrowserStack device verification response was not a list.',
    );
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.device !== 'string' ||
      typeof record.os !== 'string' ||
      (typeof record.os_version !== 'string' && typeof record.os_version !== 'number')
    ) {
      return [];
    }
    return [{ device: record.device, os: record.os, osVersion: String(record.os_version) }];
  });
}

function readBrowserStackApps(value: unknown): Array<{
  name?: string;
  reference: string;
  version?: string;
}> {
  if (!Array.isArray(value)) {
    throw new AppError('COMMAND_FAILED', 'BrowserStack app verification response was not a list.');
  }
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.app_url !== 'string') return [];
    return [
      {
        reference: record.app_url,
        ...(typeof record.app_name === 'string' ? { name: record.app_name } : {}),
        ...(typeof record.app_version === 'string' ? { version: record.app_version } : {}),
      },
    ];
  });
}

async function verifyAwsDeviceFarmConnection(
  options: Extract<CloudWebDriverConnectionVerificationOptions, { provider: 'aws-device-farm' }>,
  runHostCommand: ProviderWebDriverDependencies['runHostCommand'],
): Promise<CloudWebDriverConnectionVerification> {
  const runAwsJson = async (subcommand: string, arnFlag: string, arn: string): Promise<unknown> => {
    const result = await runHostCommand('aws', [
      'devicefarm',
      subcommand,
      ...(options.region ? ['--region', options.region] : []),
      arnFlag,
      arn,
      '--output',
      'json',
    ]);
    try {
      return JSON.parse(result.stdout) as unknown;
    } catch (error) {
      throw new AppError(
        'COMMAND_FAILED',
        `AWS Device Farm ${subcommand} returned invalid JSON.`,
        undefined,
        error,
      );
    }
  };

  const project = readAwsResource(
    await runAwsJson('get-project', '--arn', options.projectArn),
    'project',
  );
  const device = readAwsResource(
    await runAwsJson('get-device', '--arn', options.deviceArn),
    'device',
  );
  const devicePlatform = readAwsPlatform(device.platform);
  if (devicePlatform !== options.platform) {
    throw new AppError(
      'INVALID_ARGS',
      `AWS Device Farm device "${readString(device.name) ?? options.deviceArn}" is ${devicePlatform}, not ${options.platform}.`,
    );
  }

  const app = options.appArn
    ? verifyAwsUpload(
        readAwsResource(await runAwsJson('get-upload', '--arn', options.appArn), 'upload'),
        options,
      )
    : {
        status: 'missing' as const,
        message:
          'No app upload is attached; AWS Device Farm does not support install after allocation. Reconnect with --aws-app-arn <arn>.',
      };
  return {
    provider: 'aws-device-farm',
    service: 'AWS Device Farm',
    verificationMessage: options.appArn
      ? 'Credentials, project, device, and app upload verified.'
      : 'Credentials, project, and device verified.',
    project: { name: readString(project.name), reference: options.projectArn },
    device: {
      status: 'verified',
      name: readString(device.name) ?? options.deviceArn,
      reference: options.deviceArn,
      platform: devicePlatform,
      osVersion: readString(device.os),
      availability: readString(device.availability),
    },
    app,
  };
}

function verifyAwsUpload(
  upload: Record<string, unknown>,
  options: Extract<CloudWebDriverConnectionVerificationOptions, { provider: 'aws-device-farm' }>,
): VerifiedProviderResource {
  const status = readString(upload.status);
  if (status !== 'SUCCEEDED') {
    throw new AppError(
      'COMMAND_FAILED',
      `AWS Device Farm app upload is not ready (${status ?? 'unknown status'}).`,
      {
        status,
        hint: 'Wait for the upload to succeed or reconnect with a different --aws-app-arn.',
      },
    );
  }
  const expectedType = options.platform === 'android' ? 'ANDROID_APP' : 'IOS_APP';
  const type = readString(upload.type);
  if (type !== expectedType) {
    throw new AppError(
      'INVALID_ARGS',
      `AWS Device Farm app upload type is ${type ?? 'unknown'}, expected ${expectedType}.`,
    );
  }
  return {
    status: 'verified',
    name: readString(upload.name),
    reference: options.appArn,
  };
}

function readAwsResource(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== 'object') {
    throw new AppError('COMMAND_FAILED', `AWS Device Farm ${key} response was not an object.`);
  }
  const resource = (value as Record<string, unknown>)[key];
  if (!resource || typeof resource !== 'object' || Array.isArray(resource)) {
    throw new AppError('COMMAND_FAILED', `AWS Device Farm response missed ${key}.`);
  }
  return resource as Record<string, unknown>;
}

function readAwsPlatform(value: unknown): 'android' | 'ios' {
  if (value === 'ANDROID') return 'android';
  if (value === 'IOS') return 'ios';
  throw new AppError(
    'UNSUPPORTED_PLATFORM',
    `AWS Device Farm device platform is ${String(value)}.`,
  );
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
