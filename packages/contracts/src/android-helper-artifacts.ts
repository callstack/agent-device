import { AppError } from '@agent-device/kernel/errors';

// Provider-boundary artifact vocabulary for the Android helper APKs. An adb provider may ship
// its own helper artifacts (exactly as the SDK seam allows), so these shapes cross the
// provider/platform boundary and live here rather than with either implementation.

export type AndroidImeHelperManifest = {
  name: 'android-ime-helper';
  version: string;
  assetName: string;
  sha256: string;
  packageName: string;
  versionCode: number;
  serviceComponent: string;
  broadcastProtocol: 'android-ime-helper-v1';
};

export type AndroidImeHelperArtifact = {
  apkPath: string;
  manifest: AndroidImeHelperManifest;
};

export type AndroidSnapshotHelperManifest = {
  name: 'android-snapshot-helper';
  version: string;
  releaseTag?: string;
  assetName?: string;
  apkUrl: string | null;
  sha256: string;
  checksumName?: string;
  packageName: string;
  versionCode: number;
  instrumentationRunner: string;
  minSdk: number;
  targetSdk?: number;
  outputFormat: 'uiautomator-xml';
  statusProtocol: 'android-snapshot-helper-v1';
  installArgs: string[];
};

export type AndroidSnapshotHelperArtifact = {
  apkPath: string;
  manifest: AndroidSnapshotHelperManifest;
};

/** Outcome of the shared install/version-check/checksum lifecycle for a helper APK. */
export type AndroidHelperInstallDecision = {
  packageName: string;
  versionCode: number;
  installedVersionCode?: number;
  installedSha256?: string;
  installed: boolean;
  reason: 'missing' | 'outdated' | 'mismatched' | 'unverifiable' | 'current';
};

export type InstalledAndroidHelperState = Pick<
  AndroidHelperInstallDecision,
  'installedVersionCode' | 'installedSha256' | 'reason'
>;

// --- Manifest field validators, shared by every helper's manifest parser ---------------------

export function readAndroidHelperManifestInteger(
  value: unknown,
  field: string,
  helperLabel: string,
): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new AppError(
      'INVALID_ARGS',
      `Android ${helperLabel} manifest ${field} must be an integer.`,
    );
  }
  return value;
}

export function readAndroidHelperManifestLiteral<const Value extends string>(
  value: unknown,
  field: string,
  expected: Value,
  helperLabel: string,
): Value {
  if (value !== expected) {
    throw new AppError(
      'INVALID_ARGS',
      `Android ${helperLabel} manifest ${field} must be "${expected}".`,
    );
  }
  return expected;
}

export function readAndroidHelperManifestString(
  value: unknown,
  field: string,
  helperLabel: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', `Android ${helperLabel} manifest ${field} is required.`);
  }
  return value;
}

export function readAndroidHelperManifestSha256(value: unknown, helperLabel: string): string {
  const sha256 = readAndroidHelperManifestString(value, 'sha256', helperLabel).trim().toLowerCase();
  if (sha256.length !== 64 || !/^[0-9a-f]+$/.test(sha256)) {
    throw new AppError(
      'INVALID_ARGS',
      `Android ${helperLabel} manifest sha256 must be a 64-character hex string.`,
    );
  }
  return sha256;
}
