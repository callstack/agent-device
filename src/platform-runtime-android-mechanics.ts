/**
 * The Android mechanics module, resolved exactly once per process.
 *
 * Memoized for the same reason as the loaders in
 * `platform-runtime-apple-application-tools.ts`: concurrent callers must share one resolution,
 * or a `vi.mock` factory still in flight lets the second caller reach the unmocked module (#2314).
 */
let mechanicsModule: Promise<typeof import('@agent-device/platform-android/mechanics')> | undefined;

export async function loadAndroidMechanics() {
  mechanicsModule ??= import('./platform-runtime-android-adb-host.ts').then(
    async () => await import('@agent-device/platform-android/mechanics'),
  );
  return await mechanicsModule;
}
