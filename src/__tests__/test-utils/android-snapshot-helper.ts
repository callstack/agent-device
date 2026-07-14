import type { AndroidAdbExecutor } from '../../platforms/android/adb-executor.ts';

const SNAPSHOT_HELPER_PACKAGE = 'com.callstack.agentdevice.snapshothelper';

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

export function isAndroidSnapshotHelperCapture(args: readonly string[]): boolean {
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
