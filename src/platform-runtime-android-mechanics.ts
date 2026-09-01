export async function loadAndroidMechanics() {
  await import('./platform-runtime-android-adb-host.ts');
  return await import('@agent-device/platform-android/mechanics');
}
