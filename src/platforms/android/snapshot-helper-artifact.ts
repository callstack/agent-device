import crypto from 'node:crypto';
import fs from 'node:fs';
import { AppError } from '../../kernel/errors.ts';
import {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
} from './instrumentation-helper.ts';
import {
  ANDROID_SNAPSHOT_HELPER_NAME,
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  type AndroidSnapshotHelperArtifact,
  type AndroidSnapshotHelperManifest,
} from './snapshot-helper-types.ts';

export type AndroidSnapshotHelperInstallOptions = {
  replace?: boolean;
  allowTestPackages?: boolean;
  allowDowngrade?: boolean;
  grantPermissions?: boolean;
};

type AndroidSnapshotHelperInstallOptionName = keyof AndroidSnapshotHelperInstallOptions;

const ANDROID_SNAPSHOT_HELPER_INSTALL_FLAG_OPTIONS = {
  '-r': 'replace',
  '-t': 'allowTestPackages',
  '-d': 'allowDowngrade',
  '-g': 'grantPermissions',
} as const satisfies Record<string, AndroidSnapshotHelperInstallOptionName>;

type AndroidSnapshotHelperInstallFlag = keyof typeof ANDROID_SNAPSHOT_HELPER_INSTALL_FLAG_OPTIONS;

export async function verifyAndroidSnapshotHelperArtifact(
  artifact: AndroidSnapshotHelperArtifact,
): Promise<void> {
  const actual = await sha256File(artifact.apkPath);
  if (actual !== artifact.manifest.sha256) {
    throw new AppError('COMMAND_FAILED', 'Android snapshot helper APK checksum mismatch', {
      apkPath: artifact.apkPath,
      expectedSha256: artifact.manifest.sha256,
      actualSha256: actual,
    });
  }
}

export function parseAndroidSnapshotHelperManifest(value: unknown): AndroidSnapshotHelperManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Android snapshot helper manifest must be an object.');
  }
  const record = value as Record<string, unknown>;
  return {
    name: readLiteral(record.name, 'name', ANDROID_SNAPSHOT_HELPER_NAME),
    version: readString(record.version, 'version'),
    releaseTag: readOptionalString(record.releaseTag),
    assetName: readOptionalString(record.assetName),
    apkUrl: readOptionalNullableString(record.apkUrl, 'apkUrl'),
    sha256: readSha256(record.sha256),
    checksumName: readOptionalString(record.checksumName),
    packageName: readString(record.packageName, 'packageName'),
    versionCode: readNumber(record.versionCode, 'versionCode'),
    instrumentationRunner: readString(record.instrumentationRunner, 'instrumentationRunner'),
    minSdk: readNumber(record.minSdk, 'minSdk'),
    targetSdk:
      record.targetSdk === undefined ? undefined : readNumber(record.targetSdk, 'targetSdk'),
    outputFormat: readLiteral(
      record.outputFormat,
      'outputFormat',
      ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
    ),
    statusProtocol: readLiteral(
      record.statusProtocol,
      'statusProtocol',
      ANDROID_SNAPSHOT_HELPER_PROTOCOL,
    ),
    installArgs: readAndroidSnapshotHelperManifestInstallArgs(record.installArgs),
  };
}

function readNumber(value: unknown, field: string): number {
  return readAndroidHelperManifestInteger(value, field, 'snapshot helper');
}

function readLiteral<const Value extends string>(
  value: unknown,
  field: string,
  expected: Value,
): Value {
  return readAndroidHelperManifestLiteral(value, field, expected, 'snapshot helper');
}

export function readAndroidSnapshotHelperInstallOptions(
  manifest: AndroidSnapshotHelperManifest,
): AndroidSnapshotHelperInstallOptions {
  const installArgs = readAndroidSnapshotHelperManifestInstallArgs(manifest.installArgs);
  return installOptionsFromSnapshotHelperInstallArgs(installArgs);
}

function readAndroidSnapshotHelperManifestInstallArgs(value: unknown): string[] {
  const installArgs = readStringArray(value, 'installArgs');
  if (installArgs[0] !== 'install') {
    throw new AppError(
      'INVALID_ARGS',
      'Android snapshot helper manifest installArgs must start with "install".',
    );
  }
  if (installArgs.some((arg) => arg.includes('\u0000'))) {
    throw new AppError(
      'INVALID_ARGS',
      'Android snapshot helper manifest installArgs must not contain null bytes.',
    );
  }
  const unsupportedArg = installArgs.slice(1).find((arg) => !isAllowedInstallFlag(arg));
  if (unsupportedArg) {
    throw new AppError(
      'INVALID_ARGS',
      `Android snapshot helper manifest installArgs contains unsupported install flag "${unsupportedArg}".`,
    );
  }
  return installArgs;
}

function installOptionsFromSnapshotHelperInstallArgs(
  installArgs: string[],
): AndroidSnapshotHelperInstallOptions {
  const options: AndroidSnapshotHelperInstallOptions = {};
  for (const arg of installArgs.slice(1)) {
    const optionName = installOptionForSnapshotHelperInstallFlag(arg);
    if (!optionName) {
      throw new AppError(
        'INVALID_ARGS',
        `Android snapshot helper manifest installArgs contains unsupported install flag "${arg}".`,
      );
    }
    options[optionName] = true;
  }
  return options;
}

function readSha256(value: unknown): string {
  const sha256 = readString(value, 'sha256').trim().toLowerCase();
  if (sha256.length !== 64 || !isLowerHex(sha256)) {
    throw new AppError(
      'INVALID_ARGS',
      'Android snapshot helper manifest sha256 must be a 64-character hex string.',
    );
  }
  return sha256;
}

async function sha256File(filePath: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function readString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new AppError('INVALID_ARGS', `Android snapshot helper manifest ${field} is required.`);
  }
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readOptionalNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return readString(value, field);
}

function readStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) {
    throw new AppError(
      'INVALID_ARGS',
      `Android snapshot helper manifest ${field} must be a string array.`,
    );
  }
  return value;
}

function isAllowedInstallFlag(arg: string): boolean {
  return installOptionForSnapshotHelperInstallFlag(arg) !== undefined;
}

function installOptionForSnapshotHelperInstallFlag(
  arg: string,
): AndroidSnapshotHelperInstallOptionName | undefined {
  if (!Object.hasOwn(ANDROID_SNAPSHOT_HELPER_INSTALL_FLAG_OPTIONS, arg)) {
    return undefined;
  }
  return ANDROID_SNAPSHOT_HELPER_INSTALL_FLAG_OPTIONS[arg as AndroidSnapshotHelperInstallFlag];
}

function isLowerHex(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowerHexLetter = code >= 97 && code <= 102;
    if (!isDigit && !isLowerHexLetter) return false;
  }
  return true;
}
