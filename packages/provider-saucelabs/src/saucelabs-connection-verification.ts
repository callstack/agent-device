import path from 'node:path';
import type {
  ProviderConnectionResource,
  ProviderConnectionVerification,
} from '@agent-device/contracts/remote';
import { AppError } from '@agent-device/kernel/errors';
import { asOptionalRecord } from '@agent-device/kernel/record';
import {
  appendUrlPath,
  fetchProviderVerificationJson,
} from '@agent-device/provider-webdriver/plugin';
import {
  isSauceLabsAppUrl,
  parseSauceLabsAppReference,
  SAUCE_LABS_REASONS,
  sauceLabsApiEndpoint,
  type SauceLabsAppReference,
  type SauceLabsRegion,
} from './providers.ts';

/** Credentials plus the data center, device selector, OS, and app a Sauce Labs session is created with. */
export type SauceLabsConnectionVerificationOptions = {
  username: string;
  accessKey: string;
  region: SauceLabsRegion;
  platform: 'android' | 'ios';
  /** A device name, a device id for static allocation, or a name pattern for dynamic allocation. */
  deviceName: string;
  /** Absent: any OS version of the matched devices. */
  osVersion?: string;
  app: string;
};

type SauceLabsAuth = { username: string; accessKey: string };
type SauceLabsDevice = { id: string; name: string; os: string; osVersion: string };
type SauceLabsStorageFile = {
  id: string;
  name: string;
  kind?: string;
  uploadedAt: number;
  version?: string;
  simulator: boolean;
};

/** Storage pages hold at most 100 files. A name search stops after this many pages. */
const STORAGE_PAGE_SIZE = 100;
const STORAGE_MAX_PAGES = 10;

/**
 * Verifies a Sauce Labs selection without creating a session: the region's real-device catalog
 * confirms a device matches the selector, and the authenticated app storage confirms a `storage:`
 * reference names a real-device app for the same platform.
 */
export async function verifySauceLabsConnection(
  options: SauceLabsConnectionVerificationOptions,
  clientVersion: string,
): Promise<ProviderConnectionVerification> {
  const auth = { username: options.username, accessKey: options.accessKey };
  const api = sauceLabsApiEndpoint(options.region);
  const fetchJson = async (url: URL) =>
    await fetchSauceLabsJson(url, auth, { clientVersion, region: options.region });
  const catalog = await fetchJson(appendUrlPath(api, 'v1/rdc/devices'));
  const matched = matchSauceLabsDevices(readSauceLabsDevices(catalog), options);
  if (matched.length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      `Sauce Labs has no ${options.platform} real device matching "${options.deviceName}"${
        options.osVersion ? ` with OS ${options.osVersion}` : ''
      } in ${options.region}.`,
      {
        reason: SAUCE_LABS_REASONS.deviceNotFound.reason,
        region: options.region,
        hint: 'Choose a device name or id from the Sauce Labs real-device list of that data center, and an OS version it offers. SAUCE_REGION selects the data center.',
      },
    );
  }

  const app = await verifySauceLabsApp(options, api, fetchJson);
  const single = matched.length === 1 ? matched[0] : undefined;
  const osVersion = single?.osVersion ?? options.osVersion;
  return {
    provider: 'saucelabs',
    service: 'Sauce Labs',
    verificationMessage:
      app.status === 'verified'
        ? 'Credentials, device, and uploaded app verified.'
        : 'Credentials and device verified; app availability is checked when the session is created.',
    device: {
      status: 'verified',
      name: single?.name ?? options.deviceName,
      ...(single ? { reference: single.id } : {}),
      platform: options.platform,
      ...(osVersion ? { osVersion } : {}),
      ...(single
        ? {}
        : { message: `${String(matched.length)} devices match; Sauce Labs picks a free one.` }),
    },
    app,
  };
}

/**
 * Sauce Labs allocates a device whose id or name equals `deviceName`, or whose name the pattern
 * matches in full regardless of case, and whose OS version equals or starts with `osVersion`.
 */
function matchSauceLabsDevices(
  devices: SauceLabsDevice[],
  options: Pick<SauceLabsConnectionVerificationOptions, 'deviceName' | 'osVersion' | 'platform'>,
): SauceLabsDevice[] {
  const selector = options.deviceName;
  const pattern = compileDevicePattern(selector);
  const { osVersion } = options;
  return devices.filter(
    (device) =>
      device.os.toLowerCase() === options.platform &&
      (device.id === selector ||
        device.name.toLowerCase() === selector.toLowerCase() ||
        pattern?.test(device.name) === true) &&
      (osVersion === undefined ||
        normalizeOsVersion(device.osVersion) === normalizeOsVersion(osVersion) ||
        device.osVersion.startsWith(`${osVersion}.`)),
  );
}

/** `15.0` and `15` name the same release. */
function normalizeOsVersion(value: string): string {
  return value.replace(/(?:\.0)+$/, '');
}

function compileDevicePattern(selector: string): RegExp | undefined {
  try {
    return new RegExp(`^(?:${selector})$`, 'i');
  } catch {
    return undefined;
  }
}

async function verifySauceLabsApp(
  options: SauceLabsConnectionVerificationOptions,
  api: string,
  fetchJson: (url: URL) => Promise<unknown>,
): Promise<ProviderConnectionResource> {
  const { app } = options;
  // Hand-authored remote configs reach verification without passing through connect's normalization.
  const reference = parseSauceLabsAppReference(app);
  if (reference?.kind === 'file-id') {
    const url = appendUrlPath(api, 'v1/storage/files');
    url.searchParams.set('file_id', reference.fileId);
    const file = readSauceLabsStorageFiles(await fetchJson(url)).files.find(
      (entry) => entry.id.toLowerCase() === reference.fileId.toLowerCase(),
    );
    if (!file) {
      throw new AppError(
        'INVALID_ARGS',
        `Sauce Labs app storage in ${options.region} has no upload for ${reference.reference}.`,
        {
          reason: SAUCE_LABS_REASONS.appNotFound.reason,
          providerApp: reference.reference,
          region: options.region,
          hint: 'Check the file id in Sauce Labs app storage. Storage is separate per data center, so check SAUCE_REGION too.',
        },
      );
    }
    return verifiedStorageFile(reference, file, options.platform);
  }
  if (reference?.kind === 'filename') {
    const file = await newestUploadNamed(reference.filename, api, fetchJson);
    if (file) return verifiedStorageFile(reference, file, options.platform);
    return {
      status: 'configured',
      reference: reference.reference,
      message: `No upload named ${reference.filename} was found in ${options.region} app storage; Sauce Labs resolves the name when creating the session.`,
    };
  }
  if (isSauceLabsAppUrl(app)) {
    return {
      status: 'configured',
      reference: app,
      message: 'App URL configured; Sauce Labs fetches it when creating the session.',
    };
  }
  return {
    status: 'configured',
    name: path.basename(app),
    reference: app,
    message: 'Local app artifact is ready and will be uploaded when creating the session.',
  };
}

/**
 * The newest upload with exactly this name, as the hub resolves `storage:filename=`. The name search
 * matches without regard to case, so the pages are filtered for the exact name. Undefined when the
 * pages run out, or the page budget does, without a match.
 */
async function newestUploadNamed(
  filename: string,
  api: string,
  fetchJson: (url: URL) => Promise<unknown>,
): Promise<SauceLabsStorageFile | undefined> {
  const matches: SauceLabsStorageFile[] = [];
  for (let page = 1; page <= STORAGE_MAX_PAGES; page += 1) {
    const url = appendUrlPath(api, 'v1/storage/files');
    url.searchParams.set('name', filename);
    url.searchParams.set('per_page', String(STORAGE_PAGE_SIZE));
    url.searchParams.set('page', String(page));
    const { files, hasNext } = readSauceLabsStorageFiles(await fetchJson(url));
    matches.push(...files.filter((entry) => entry.name === filename));
    if (!hasNext) break;
  }
  return matches.sort((left, right) => right.uploadedAt - left.uploadedAt)[0];
}

function verifiedStorageFile(
  reference: SauceLabsAppReference,
  file: SauceLabsStorageFile,
  platform: 'android' | 'ios',
): ProviderConnectionResource {
  const details = { providerApp: reference.reference, fileName: file.name };
  if (file.kind !== 'android' && file.kind !== 'ios') {
    throw new AppError(
      'INVALID_ARGS',
      `Sauce Labs upload ${file.name} is not an Android or iOS app (kind ${file.kind ?? 'unknown'}).`,
      {
        ...details,
        reason: SAUCE_LABS_REASONS.appKindUnsupported.reason,
        appKind: file.kind,
        hint: 'Pass an .apk, .aab, or .ipa upload.',
      },
    );
  }
  if (file.kind !== platform) {
    throw new AppError(
      'INVALID_ARGS',
      `Sauce Labs upload ${file.name} is a ${file.kind} app, not a ${platform} app.`,
      {
        ...details,
        reason: SAUCE_LABS_REASONS.appPlatformMismatch.reason,
        appKind: file.kind,
        platform,
        hint: `Pass an upload built for ${platform}, or connect with the platform the app is built for.`,
      },
    );
  }
  if (file.simulator) {
    throw new AppError(
      'INVALID_ARGS',
      `Sauce Labs upload ${file.name} is an iOS simulator build, which a real device cannot install.`,
      {
        ...details,
        reason: SAUCE_LABS_REASONS.appSimulatorBuild.reason,
        hint: 'Pass a signed .ipa built for devices.',
      },
    );
  }
  return {
    status: 'verified',
    name: file.name,
    reference: reference.reference,
    ...(file.version ? { version: file.version } : {}),
  };
}

async function fetchSauceLabsJson(
  endpoint: URL,
  auth: SauceLabsAuth,
  context: { clientVersion: string; region: SauceLabsRegion },
): Promise<unknown> {
  return await fetchProviderVerificationJson(endpoint, {
    clientVersion: context.clientVersion,
    auth,
    hints: {
      service: 'Sauce Labs',
      unauthorizedHint: `Check SAUCE_USERNAME and SAUCE_ACCESS_KEY, and that the account can use the ${context.region} data center.`,
      networkHint: `Check network access to api.${context.region}.saucelabs.com and retry connect.`,
    },
  });
}

function readSauceLabsDevices(value: unknown): SauceLabsDevice[] {
  if (!Array.isArray(value)) {
    throw new AppError('COMMAND_FAILED', 'Sauce Labs device catalog response was not a list.');
  }
  return value.flatMap((entry) => {
    const record = asOptionalRecord(entry);
    const osVersion = record?.osVersion;
    return record &&
      typeof record.id === 'string' &&
      typeof record.name === 'string' &&
      typeof record.os === 'string' &&
      (typeof osVersion === 'string' || typeof osVersion === 'number')
      ? [{ id: record.id, name: record.name, os: record.os, osVersion: String(osVersion) }]
      : [];
  });
}

function readSauceLabsStorageFiles(value: unknown): {
  files: SauceLabsStorageFile[];
  hasNext: boolean;
} {
  const record = asOptionalRecord(value);
  const items = record?.items;
  if (!Array.isArray(items)) {
    throw new AppError('COMMAND_FAILED', 'Sauce Labs app storage response held no file list.');
  }
  const files = items.flatMap((entry) => {
    const file = asOptionalRecord(entry);
    if (!file || typeof file.id !== 'string' || typeof file.name !== 'string') return [];
    const metadata = asOptionalRecord(file.metadata);
    const version = metadata?.version;
    return [
      {
        id: file.id,
        name: file.name,
        ...(typeof file.kind === 'string' ? { kind: file.kind.toLowerCase() } : {}),
        uploadedAt: typeof file.upload_timestamp === 'number' ? file.upload_timestamp : 0,
        ...(typeof version === 'string' ? { version } : {}),
        simulator: metadata?.is_simulator === true,
      },
    ];
  });
  const next = asOptionalRecord(record?.links)?.next;
  return { files, hasNext: typeof next === 'string' && next.length > 0 };
}
