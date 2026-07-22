import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';
import type { AndroidSnapshotHelperArtifact } from '../../platforms/android/snapshot-helper-types.ts';
import { fileURLToPath } from 'node:url';

const SNAPSHOT_HELPER_PACKAGE = 'com.callstack.agentdevice.snapshothelper';
const SNAPSHOT_HELPER_FIXTURE_APK_PATH = fileURLToPath(
  new URL('./fixtures/android-helper-apk.fixture', import.meta.url),
);
const SNAPSHOT_HELPER_FIXTURE_APK_SHA256 =
  'a5f6a2fba1163bba2f13026bd3a192f52ba2816524b7cfa83c6b7ca568f6710a';

export const ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT: AndroidSnapshotHelperArtifact = {
  apkPath: SNAPSHOT_HELPER_FIXTURE_APK_PATH,
  manifest: {
    name: 'android-snapshot-helper',
    version: '0.13.3',
    apkUrl: null,
    sha256: SNAPSHOT_HELPER_FIXTURE_APK_SHA256,
    packageName: SNAPSHOT_HELPER_PACKAGE,
    versionCode: 13003,
    instrumentationRunner: `${SNAPSHOT_HELPER_PACKAGE}/.SnapshotInstrumentation`,
    minSdk: 23,
    targetSdk: 36,
    outputFormat: 'uiautomator-xml',
    statusProtocol: 'android-snapshot-helper-v1',
    installArgs: ['install', '-r', '-t'],
  },
};

export function createAndroidSnapshotHelperExecutor(options: {
  readonly exec: AndroidAdbExecutor;
  readonly captureXml: () => string | Promise<string>;
}): AndroidAdbExecutor {
  return async (args, execOptions) => {
    if (isAndroidSnapshotHelperVersionProbe(args)) {
      return {
        exitCode: 0,
        stdout: `package:${SNAPSHOT_HELPER_PACKAGE} versionCode:999999`,
        stderr: '',
      };
    }
    if (isAndroidSnapshotHelperCapture(args)) {
      return {
        exitCode: 0,
        stdout: androidSnapshotHelperOutput(await options.captureXml()),
        stderr: '',
      };
    }
    return await options.exec(args, execOptions);
  };
}

function isAndroidSnapshotHelperCapture(args: readonly string[]): boolean {
  return args[0] === 'shell' && args[1] === 'am' && args[2] === 'instrument';
}

export function androidSnapshotHelperOutput(xml: string): string {
  return [
    'INSTRUMENTATION_STATUS: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_STATUS: helperApiVersion=1',
    'INSTRUMENTATION_STATUS: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_STATUS: chunkIndex=0',
    'INSTRUMENTATION_STATUS: chunkCount=1',
    `INSTRUMENTATION_STATUS: payloadBase64=${Buffer.from(xml, 'utf8').toString('base64')}`,
    'INSTRUMENTATION_STATUS_CODE: 1',
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    'INSTRUMENTATION_RESULT: helperApiVersion=1',
    'INSTRUMENTATION_RESULT: ok=true',
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}

function isAndroidSnapshotHelperVersionProbe(args: readonly string[]): boolean {
  return args.includes('--show-versioncode') && args.includes(SNAPSHOT_HELPER_PACKAGE);
}
