import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import { appendUrlPath, asRecord, fetchProviderVerificationJson } from './webdriver-utils.ts';
import {
  TESTMU_API_ENDPOINT,
  TESTMU_APPS_ENDPOINT,
  isTestMuAppReference,
  testMuAppReferenceFromId,
} from './testmu.ts';
import type {
  CloudWebDriverConnectionVerification,
  CloudWebDriverConnectionVerificationOptions,
} from './connection-verification.ts';
import type {
  ProviderConnectionResource,
  ProviderDeviceType,
} from '@agent-device/contracts/remote';

type TestMuOptions = Extract<CloudWebDriverConnectionVerificationOptions, { provider: 'testmu' }>;

type TestMuAuth = { username: string; accessKey: string };

/** `/app/data?type=` keys uploads by pool: real-device apps by platform, virtual ones by runtime. */
const TESTMU_APP_LIST_TYPES: Record<ProviderDeviceType, Record<'android' | 'ios', string>> = {
  real: { android: 'android', ios: 'ios' },
  virtual: { android: 'emulator', ios: 'simulator' },
};

/**
 * Verifies a TestMu device selection without creating a session: the public capability catalog
 * of the selected pool (real or virtual) confirms the device/OS pair exists, and the
 * authenticated app listing confirms the credentials and, for an `lt://` reference, the upload.
 */
export async function verifyTestMuConnection(
  options: TestMuOptions,
  clientVersion: string,
): Promise<CloudWebDriverConnectionVerification> {
  const auth = { username: options.username, accessKey: options.accessKey };
  const deviceType = options.deviceType ?? 'virtual';
  const catalogUrl = options.devicesEndpoint
    ? new URL(options.devicesEndpoint)
    : appendUrlPath(options.apiEndpoint ?? TESTMU_API_ENDPOINT, 'capability/generator');
  catalogUrl.searchParams.set('isVirtualDevice', String(deviceType === 'virtual'));
  const catalog = await fetchTestMuJson(catalogUrl, undefined, clientVersion);
  const namedDevices = readTestMuCatalogDevices(catalog, options.platform, deviceType).filter(
    (device) => device.name === options.deviceName,
  );
  // Exact match on purpose: the hub rejects `18` for a virtual device the catalog lists as `18.0`,
  // and real iOS devices are listed by major version only.
  const matchedDevice = namedDevices.find((device) =>
    device.osVersions.includes(options.osVersion),
  );
  if (!matchedDevice) {
    const offered = [...new Set(namedDevices.flatMap((device) => device.osVersions))].sort(
      (left, right) => left.localeCompare(right, undefined, { numeric: true }),
    );
    throw new AppError(
      'INVALID_ARGS',
      `TestMu AI ${deviceType} device "${options.deviceName}" with ${options.platform} ${options.osVersion} is not available${
        offered.length > 0 ? `; ${options.deviceName} offers ${offered.join(', ')}` : ''
      }.`,
      {
        hint: `Choose an exact device name and OS version from the TestMu AI ${deviceType}-device capability generator.`,
        deviceType,
        ...(offered.length > 0 ? { availableOsVersions: offered } : {}),
      },
    );
  }

  const app = await verifyTestMuApp(options, deviceType, auth, clientVersion);
  return {
    provider: 'testmu',
    service: 'TestMu AI',
    verificationMessage:
      app.status === 'verified'
        ? `Credentials, ${deviceType} device, and uploaded app verified.`
        : `Credentials and ${deviceType} device verified; app availability is checked when the session is created.`,
    device: {
      status: 'verified',
      name: matchedDevice.name,
      platform: options.platform,
      osVersion: options.osVersion,
    },
    app,
  };
}

async function verifyTestMuApp(
  options: TestMuOptions,
  deviceType: ProviderDeviceType,
  auth: TestMuAuth,
  clientVersion: string,
): Promise<ProviderConnectionResource> {
  const { app } = options;
  // The listing is authenticated, so it doubles as the credential check for every app kind.
  const appsUrl = new URL(options.appsEndpoint ?? TESTMU_APPS_ENDPOINT);
  appsUrl.searchParams.set('type', TESTMU_APP_LIST_TYPES[deviceType][options.platform]);
  appsUrl.searchParams.set('level', 'user');
  const apps = await fetchTestMuJson(appsUrl, auth, clientVersion);
  if (isTestMuAppReference(app)) {
    const matched = readTestMuApps(apps).find((entry) => entry.reference === app);
    if (!matched) {
      return {
        status: 'configured',
        reference: app,
        message: `App reference was not found among your ${deviceType}-device uploads; TestMu AI validates it when creating the session.`,
      };
    }
    return { status: 'verified', ...matched };
  }
  if (/^https?:\/\//i.test(app)) {
    return {
      status: 'configured',
      reference: app,
      message: 'Public app URL configured; TestMu AI fetches it when creating the session.',
    };
  }
  return {
    status: 'configured',
    name: path.basename(app),
    reference: app,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

async function fetchTestMuJson(
  endpoint: string | URL,
  auth: TestMuAuth | undefined,
  clientVersion: string,
): Promise<unknown> {
  return await fetchProviderVerificationJson(endpoint, {
    clientVersion,
    auth,
    hints: {
      service: 'TestMu AI',
      unauthorizedHint: 'Check LT_USERNAME and LT_ACCESS_KEY.',
      serviceHint: 'Retry connect or check the TestMu AI service status.',
      networkHint:
        'Check network access to mobile-api.lambdatest.com and manual-api.lambdatest.com, then retry connect.',
    },
  });
}

/**
 * The capability generator lists devices per platform as `brands.<brand>[]` of
 * `{ name, osVersion: string[] }`: under `app.devices.<platform>` for the virtual pool
 * (`isVirtualDevice=true`), and directly under `<platform>` for the real pool.
 */
function readTestMuCatalogDevices(
  value: unknown,
  platform: 'android' | 'ios',
  deviceType: ProviderDeviceType,
): Array<{ name: string; osVersions: string[] }> {
  const platformCatalog =
    deviceType === 'real'
      ? asRecord(asRecord(value)?.[platform])
      : asRecord(asRecord(asRecord(asRecord(value)?.app)?.devices)?.[platform]);
  const brandRecord = asRecord(platformCatalog?.brands);
  if (!brandRecord) {
    throw new AppError(
      'COMMAND_FAILED',
      `TestMu AI ${deviceType}-device catalog response did not list devices for the platform.`,
      { platform, deviceType },
    );
  }
  return Object.values(brandRecord).flatMap((devices) => {
    if (!Array.isArray(devices)) return [];
    return devices.flatMap((entry) => {
      const record = asRecord(entry);
      if (!record || typeof record.name !== 'string' || !Array.isArray(record.osVersion)) return [];
      const osVersions = record.osVersion.flatMap((osVersion) =>
        typeof osVersion === 'string' || typeof osVersion === 'number' ? [String(osVersion)] : [],
      );
      return [{ name: record.name, osVersions }];
    });
  });
}

/** `/app/data` answers `{ data: [{ app_id, name, version, ... }], metaData }`. */
function readTestMuApps(
  value: unknown,
): Array<{ name?: string; reference: string; version?: string }> {
  const record = asRecord(value);
  const data = record?.data;
  if (!Array.isArray(data)) {
    throw new AppError('COMMAND_FAILED', 'TestMu AI app listing response was not a list.');
  }
  return data.flatMap((entry) => {
    const app = asRecord(entry);
    if (!app || typeof app.app_id !== 'string') return [];
    const reference = testMuAppReferenceFromId(app.app_id);
    return [
      {
        reference,
        ...(typeof app.name === 'string' ? { name: app.name } : {}),
        ...(typeof app.version === 'string' ? { version: app.version } : {}),
      },
    ];
  });
}
