import { AppError, type ReasonTable } from '@agent-device/kernel/errors';

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
  broadcastProtocol: 'android-ime-helper-v2';
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
  reason: AndroidHelperInstallStateReason | 'current';
};

/**
 * Why the helper APK already on the device is not the bundled one. The install that follows the
 * refusal publishes the state as `error.details.reason` when the push fails. `current` is a
 * decision state that is never published, so it has no row.
 */
export const ANDROID_HELPER_INSTALL_STATE_REASONS = {
  // The device has no package installed under the helper's name.
  missing: { reason: 'missing' },
  // The installed helper's versionCode is below the bundled artifact's.
  outdated: { reason: 'outdated' },
  // The installed helper matches the artifact's versionCode but not its APK checksum.
  mismatched: { reason: 'mismatched' },
  // The installed helper's APK checksum could not be read, so its currency stays unproven.
  unverifiable: { reason: 'unverifiable' },
} as const satisfies ReasonTable<'android helper install'>;

type AndroidHelperInstallStateRows = typeof ANDROID_HELPER_INSTALL_STATE_REASONS;
type AndroidHelperInstallStateReason =
  AndroidHelperInstallStateRows[keyof AndroidHelperInstallStateRows]['reason'];

export type InstalledAndroidHelperState =
  | {
      reason: AndroidHelperInstallStateRows['missing']['reason'];
      installedVersionCode?: never;
      installedSha256?: never;
    }
  | {
      reason:
        | AndroidHelperInstallStateRows['outdated']['reason']
        | AndroidHelperInstallStateRows['unverifiable']['reason'];
      installedVersionCode: number;
      installedSha256?: never;
    }
  | {
      reason: AndroidHelperInstallStateRows['mismatched']['reason'];
      installedVersionCode: number;
      installedSha256: string;
    }
  | { reason: 'current'; installedVersionCode: number; installedSha256?: string };

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
