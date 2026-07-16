// The one-shot touch helper path now runs through the snapshot-helper APK/runner
// (issue #1275 consolidation), so these fixtures mirror the snapshot helper's
// package/protocol identity rather than the retired standalone multitouch helper.
export const ANDROID_TOUCH_HELPER_MANIFEST = {
  name: 'android-snapshot-helper' as const,
  version: '0.17.0',
  assetName: 'helper.apk',
  sha256: 'a'.repeat(64),
  packageName: 'com.callstack.agentdevice.snapshothelper',
  versionCode: 17000,
  instrumentationRunner: 'com.callstack.agentdevice.snapshothelper/.SnapshotInstrumentation',
  statusProtocol: 'android-snapshot-helper-v1' as const,
};

export function androidTouchHelperResultRecord(values: Record<string, string>): string {
  return [
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-snapshot-helper-v1',
    ...Object.entries(values).map(([key, value]) => `INSTRUMENTATION_RESULT: ${key}=${value}`),
  ].join('\n');
}
