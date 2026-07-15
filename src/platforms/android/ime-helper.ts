import { AppError } from '../../kernel/errors.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import { androidAdbResultError, type AndroidAdbExecutor } from './adb-executor.ts';
import {
  readAndroidHelperManifestInteger,
  readAndroidHelperManifestLiteral,
  readAndroidHelperManifestSha256,
  readAndroidHelperManifestString,
} from './instrumentation-helper.ts';
import {
  makeEnsureAndroidHelperInstalled,
  resolveAndroidHelperArtifact,
} from './helper-package-install.ts';

// Headless InputMethodService, driven over `adb shell am broadcast` (not `am instrument`).

const HELPER_LABEL = 'Android IME helper';
// readAndroidHelperManifestXxx already prepend "Android " to this label.
const MANIFEST_HELPER_LABEL = 'IME helper';
const ANDROID_IME_HELPER_NAME = 'android-ime-helper';
const ANDROID_IME_HELPER_PACKAGE = 'com.callstack.agentdevice.imehelper';
const ANDROID_IME_HELPER_SERVICE = 'com.callstack.agentdevice.imehelper/.TestInputMethodService';
const ANDROID_IME_HELPER_PROTOCOL = 'android-ime-helper-v1';

// Stable service-component id, matched literally by the manifest parser. Exported so the restore
// lifecycle can compare the device's active IME without reading the packaged artifact from disk.
export const ANDROID_IME_HELPER_SERVICE_COMPONENT = ANDROID_IME_HELPER_SERVICE;
const ANDROID_IME_HELPER_INSTALL_TIMEOUT_MS = 30_000;
const ANDROID_IME_HELPER_BROADCAST_TIMEOUT_MS = 10_000;

const ACTION_INPUT_TEXT_B64 = 'com.callstack.agentdevice.imehelper.ACTION_INPUT_TEXT_B64';
const ACTION_CLEAR_TEXT = 'com.callstack.agentdevice.imehelper.ACTION_CLEAR_TEXT';

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

export async function resolveAndroidImeHelperArtifact(): Promise<AndroidImeHelperArtifact> {
  return await resolveAndroidHelperArtifact({
    helperDirName: 'ime-helper',
    manifestFileName: (version) => `agent-device-android-ime-helper-${version}.manifest.json`,
    parseManifest: parseAndroidImeHelperManifest,
    unavailableMessage:
      'Android test IME text entry requires the bundled Android IME helper artifact, but it was not found or could not be read',
  });
}

function parseAndroidImeHelperManifest(value: unknown): AndroidImeHelperManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Android IME helper manifest must be an object.');
  }
  const record = value as Record<string, unknown>;
  return {
    name: readAndroidHelperManifestLiteral(
      record.name,
      'name',
      ANDROID_IME_HELPER_NAME,
      MANIFEST_HELPER_LABEL,
    ),
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
      ANDROID_IME_HELPER_PACKAGE,
      MANIFEST_HELPER_LABEL,
    ),
    versionCode: readAndroidHelperManifestInteger(
      record.versionCode,
      'versionCode',
      MANIFEST_HELPER_LABEL,
    ),
    serviceComponent: readAndroidHelperManifestLiteral(
      record.serviceComponent,
      'serviceComponent',
      ANDROID_IME_HELPER_SERVICE,
      MANIFEST_HELPER_LABEL,
    ),
    broadcastProtocol: readAndroidHelperManifestLiteral(
      record.broadcastProtocol,
      'broadcastProtocol',
      ANDROID_IME_HELPER_PROTOCOL,
      MANIFEST_HELPER_LABEL,
    ),
  };
}

const installedImeHelpers = new Set<string>();

export const ensureAndroidImeHelper = makeEnsureAndroidHelperInstalled<AndroidImeHelperArtifact>({
  cache: installedImeHelpers,
  installTimeoutMs: ANDROID_IME_HELPER_INSTALL_TIMEOUT_MS,
  helperLabel: HELPER_LABEL,
});

export function resetAndroidImeHelperInstallCache(): void {
  installedImeHelpers.clear();
}

export function getAndroidImeHelperDeviceKey(device: DeviceInfo): string {
  return `${device.platform}:${device.id}`;
}

// --- Broadcast text-entry channel -----------------------------------------------------------
// The IME's receiver requires the WRITE_SECURE_SETTINGS sender permission, which adb shell holds
// but a co-installed third-party app cannot — that permission gate (not the transport) is the
// trust boundary. Broadcasts are package-scoped (`-p`) to the in-process dynamic receiver.

export async function sendAndroidImeHelperText(
  adb: AndroidAdbExecutor,
  packageName: string,
  text: string,
): Promise<void> {
  const payloadBase64 = Buffer.from(text, 'utf8').toString('base64');
  await sendAndroidImeHelperBroadcast(adb, packageName, ACTION_INPUT_TEXT_B64, {
    text: payloadBase64,
  });
}

export async function clearAndroidImeHelperText(
  adb: AndroidAdbExecutor,
  packageName: string,
): Promise<void> {
  await sendAndroidImeHelperBroadcast(adb, packageName, ACTION_CLEAR_TEXT, {});
}

async function sendAndroidImeHelperBroadcast(
  adb: AndroidAdbExecutor,
  packageName: string,
  action: string,
  extras: Record<string, string>,
): Promise<void> {
  const args = ['shell', 'am', 'broadcast', '-p', packageName, '-a', action];
  args.push('--es', 'protocol', ANDROID_IME_HELPER_PROTOCOL);
  for (const [key, value] of Object.entries(extras)) {
    args.push('--es', key, value);
  }
  const result = await adb(args, {
    allowFailure: true,
    timeoutMs: ANDROID_IME_HELPER_BROADCAST_TIMEOUT_MS,
  });
  if (result.exitCode !== 0) {
    throw androidAdbResultError('Android IME helper broadcast failed', result, {
      action,
      packageName,
    });
  }
}
