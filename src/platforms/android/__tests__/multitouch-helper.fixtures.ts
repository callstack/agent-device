export const ANDROID_MULTITOUCH_HELPER_MANIFEST = {
  name: 'android-multitouch-helper' as const,
  version: '0.15.0',
  assetName: 'helper.apk',
  sha256: 'a'.repeat(64),
  packageName: 'com.callstack.agentdevice.multitouchhelper',
  versionCode: 15000,
  instrumentationRunner: 'com.callstack.agentdevice.multitouchhelper/.MultiTouchInstrumentation',
  statusProtocol: 'android-multitouch-helper-v1' as const,
};

export function androidMultiTouchResultRecord(values: Record<string, string>): string {
  return [
    'INSTRUMENTATION_RESULT: agentDeviceProtocol=android-multitouch-helper-v1',
    ...Object.entries(values).map(([key, value]) => `INSTRUMENTATION_RESULT: ${key}=${value}`),
  ].join('\n');
}
