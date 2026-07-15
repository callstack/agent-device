import { AppError } from '../../kernel/errors.ts';
import {
  makeEnsureAndroidHelperInstalled,
  resolveAndroidHelperArtifact,
} from './helper-package-install.ts';
import {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
  readAndroidHelperManifestSha256,
  readAndroidHelperManifestString,
} from './instrumentation-helper.ts';

const HELPER_NAME = 'android-multitouch-helper';
const HELPER_PACKAGE = 'com.callstack.agentdevice.multitouchhelper';
const HELPER_RUNNER = 'com.callstack.agentdevice.multitouchhelper/.MultiTouchInstrumentation';
export const ANDROID_MULTITOUCH_HELPER_PROTOCOL = 'android-multitouch-helper-v1';
const HELPER_INSTALL_TIMEOUT_MS = 30_000;
const HELPER_LABEL = 'Android multi-touch helper';
const MANIFEST_HELPER_LABEL = 'multi-touch helper';

type AndroidMultiTouchHelperManifest = {
  name: 'android-multitouch-helper';
  version: string;
  assetName: string;
  sha256: string;
  packageName: string;
  versionCode: number;
  instrumentationRunner: string;
  statusProtocol: 'android-multitouch-helper-v1';
};

export type AndroidMultiTouchHelperArtifact = {
  apkPath: string;
  manifest: AndroidMultiTouchHelperManifest;
};

export async function resolveAndroidMultiTouchHelperArtifact(): Promise<AndroidMultiTouchHelperArtifact> {
  return await resolveAndroidHelperArtifact({
    helperDirName: 'multitouch-helper',
    manifestFileName: (version) =>
      `agent-device-android-multitouch-helper-${version}.manifest.json`,
    parseManifest: parseAndroidMultiTouchHelperManifest,
    unavailableMessage:
      'Android touch gestures require the bundled Android touch helper artifact, but it was not found or could not be read',
  });
}

function parseAndroidMultiTouchHelperManifest(value: unknown): AndroidMultiTouchHelperManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Android multi-touch helper manifest must be an object.');
  }
  const record = value as Record<string, unknown>;
  return {
    name: readAndroidHelperManifestLiteral(record.name, 'name', HELPER_NAME, MANIFEST_HELPER_LABEL),
    version: readAndroidHelperManifestString(record.version, 'version', MANIFEST_HELPER_LABEL),
    assetName: readAndroidHelperManifestString(
      record.assetName,
      'assetName',
      MANIFEST_HELPER_LABEL,
    ),
    sha256: readAndroidHelperManifestSha256(record.sha256, MANIFEST_HELPER_LABEL),
    packageName: readAndroidHelperManifestLiteral(
      record.packageName,
      'packageName',
      HELPER_PACKAGE,
      MANIFEST_HELPER_LABEL,
    ),
    versionCode: readAndroidHelperManifestInteger(
      record.versionCode,
      'versionCode',
      MANIFEST_HELPER_LABEL,
    ),
    instrumentationRunner: readAndroidHelperManifestLiteral(
      record.instrumentationRunner,
      'instrumentationRunner',
      HELPER_RUNNER,
      MANIFEST_HELPER_LABEL,
    ),
    statusProtocol: readAndroidHelperManifestLiteral(
      record.statusProtocol,
      'statusProtocol',
      ANDROID_MULTITOUCH_HELPER_PROTOCOL,
      MANIFEST_HELPER_LABEL,
    ),
  };
}

const installedMultiTouchHelpers = new Set<string>();

export const ensureAndroidMultiTouchHelper =
  makeEnsureAndroidHelperInstalled<AndroidMultiTouchHelperArtifact>({
    cache: installedMultiTouchHelpers,
    installTimeoutMs: HELPER_INSTALL_TIMEOUT_MS,
    helperLabel: HELPER_LABEL,
  });
