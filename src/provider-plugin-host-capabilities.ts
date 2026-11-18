import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { withCommandHost } from '@agent-device/host-kit/command';
import type { ProviderAndroidHost, ProviderHostCapabilities } from '@agent-device/plugins/host';

/**
 * The host capabilities the provider plugin registry adds to every plugin `setup` host, built by
 * `PROVIDER_PLUGIN_POLICY`. Each operation runs under `host`: commands resolve from its env/cwd,
 * so ambient process values never leak into a plugin's platform call. The facets expose the
 * existing platform owners; they add no platform behavior of their own. The composition root loads
 * them only when a plugin runtime is set up.
 *
 * The facet types mirror the platform's adb shapes structurally, so each method forwards its
 * arguments to the platform's mechanics unchanged and only widens what a plugin may hand over:
 * `withAdbProvider` accepts the facet's provider mirror, which the platform normalizes the same
 * way as its own.
 */
export async function createProviderHostCapabilities(
  host: HostEnvironment,
): Promise<ProviderHostCapabilities> {
  // The host adb port refuses an unbound host; this wiring binds it once and loads no device state.
  await import('./platform-runtime-android-adb-host.ts');
  const { createAppleApplicationTools } =
    await import('./platform-runtime-apple-application-tools.ts');
  const runOnHost = <T>(task: () => Promise<T>) =>
    withCommandHost({ host, requestEnv: undefined }, task);
  return Object.freeze({
    android: createProviderAndroidHost(runOnHost),
    apple: Object.freeze({ applicationTools: createAppleApplicationTools(host.env) }),
  } satisfies ProviderHostCapabilities);
}

function createProviderAndroidHost(
  runOnHost: <T>(task: () => Promise<T>) => Promise<T>,
): ProviderAndroidHost {
  return Object.freeze({
    runAdb: async (invocation, options) => {
      const { runAndroidHostAdb } = await import('@agent-device/platform-android/mechanics');
      return await runOnHost(() => runAndroidHostAdb(invocation, options));
    },
    adbError: async (message, result, invocation) => {
      // Error construction is async so the platform helper remains lazy until an ADB failure.
      const { androidAdbResultError, serializeAndroidAdbInvocation } =
        await import('@agent-device/platform-android/mechanics');
      return androidAdbResultError(
        message,
        result,
        invocation
          ? { command: `adb ${serializeAndroidAdbInvocation(invocation).join(' ')}` }
          : undefined,
      );
    },
    withAdbProvider: async (provider, serial, task) => {
      const { withAndroidAdbProvider } = await import('@agent-device/platform-android/mechanics');
      // The facet mirror is a structural subset of the platform provider; the platform
      // normalizes a bare executor exactly as a provider carrying only `exec`.
      return await runOnHost(() =>
        withAndroidAdbProvider(
          provider as Parameters<typeof withAndroidAdbProvider>[0],
          { serial },
          task,
        ),
      );
    },
    runShell: async (adb, words, options) => {
      const { runAdbShell } = await import('@agent-device/platform-android/mechanics');
      return await runAdbShell(adb, words, options);
    },
    createPortReverse: async (adb, options) => {
      const { createAndroidPortReverseManager } =
        await import('@agent-device/platform-android/mechanics');
      return createAndroidPortReverseManager(adb, options);
    },
    listApps: async (adb, options) => {
      const { listAndroidAppsWithAdb } = await import('@agent-device/platform-android/mechanics');
      return await listAndroidAppsWithAdb(adb, options);
    },
    readLogs: async (adb, options) => {
      const { captureAndroidLogcatWithAdb } =
        await import('@agent-device/platform-android/mechanics');
      return await captureAndroidLogcatWithAdb(adb, options);
    },
    keyboardState: async (adb) => {
      const { getAndroidKeyboardStatusWithAdb } =
        await import('@agent-device/platform-android/mechanics');
      return await getAndroidKeyboardStatusWithAdb(adb);
    },
    dismissKeyboard: async (adb) => {
      const { dismissAndroidKeyboardWithAdb } =
        await import('@agent-device/platform-android/mechanics');
      return await dismissAndroidKeyboardWithAdb(adb);
    },
  } satisfies ProviderAndroidHost);
}
