import { AppError } from '@agent-device/kernel/errors';
import {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
} from './instrumentation-helper.ts';
import {
  ANDROID_SNAPSHOT_HELPER_NAME,
  ANDROID_SNAPSHOT_HELPER_OUTPUT_FORMAT,
  ANDROID_SNAPSHOT_HELPER_PROTOCOL,
  type AndroidSnapshotHelperManifest,
} from './snapshot-helper-types.ts';

// Release manifests up to 0.21.3 also carried `installArgs`; it only ever encoded the `-t` flag the
// former `testOnly` helper needed, so the parser ignores it and the helper installs with a fixed
// `adb install -r` like every other helper APK.
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

function isLowerHex(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isLowerHexLetter = code >= 97 && code <= 102;
    if (!isDigit && !isLowerHexLetter) return false;
  }
  return true;
}
