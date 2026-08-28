import type { DeviceInfo } from '@agent-device/kernel/device';
import { ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT } from './test-utils/android-snapshot-helper.ts';
import type { AndroidAdbExecutor } from '../snapshot-helper.ts';

export const androidSnapshotQualityDevice: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

export const androidSnapshotQualityHelperArtifact = ANDROID_SNAPSHOT_HELPER_FIXTURE_ARTIFACT;

const installedHelperProbe = {
  exitCode: 0,
  stdout: 'package:com.callstack.agentdevice.snapshothelper versionCode:13004',
  stderr: '',
};

export function androidSnapshotQualityHelperAdb(xml: string): AndroidAdbExecutor {
  return async (args) => {
    if (args.includes('--show-versioncode')) return installedHelperProbe;
    if (args[0] === 'shell' && args[1] === 'am' && args[2] === 'force-stop') {
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (args.includes('instrument')) {
      return { exitCode: 0, stdout: helperOutput(xml), stderr: '' };
    }
    throw new Error(`unexpected helper adb args: ${args.join(' ')}`);
  };
}

function helperOutput(xml: string): string {
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
    'INSTRUMENTATION_RESULT: outputFormat=uiautomator-xml',
    'INSTRUMENTATION_RESULT: waitForIdleTimeoutMs=0',
    'INSTRUMENTATION_RESULT: timeoutMs=8000',
    'INSTRUMENTATION_RESULT: maxDepth=128',
    'INSTRUMENTATION_RESULT: maxNodes=5000',
    'INSTRUMENTATION_RESULT: rootPresent=true',
    'INSTRUMENTATION_RESULT: captureMode=interactive-windows',
    'INSTRUMENTATION_RESULT: windowCount=1',
    'INSTRUMENTATION_RESULT: nodeCount=1',
    'INSTRUMENTATION_RESULT: truncated=false',
    'INSTRUMENTATION_RESULT: elapsedMs=12',
    'INSTRUMENTATION_CODE: 0',
  ].join('\n');
}
