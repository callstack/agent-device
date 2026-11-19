import type { HostEnvironment } from '@agent-device/kernel/source-value';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { withCommandHost } from '@agent-device/host-kit/command';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import type { AppleApplicationToolsForProvider } from '@agent-device/contracts/application-lifecycle-runtime';
import { availableAppleApplicationToolsForProvider } from '@agent-device/contracts/application-lifecycle-runtime';
import type {
  ProviderAndroidAdbProvider,
  ProviderAndroidExecutor,
  ProviderAndroidExecutorOptions,
  ProviderAndroidHost,
  ProviderHostCapabilities,
} from '@agent-device/plugins/host';

/** The platform executor shapes, read from the mechanics the facet forwards to. */
type PlatformAdbExecutor = Parameters<
  typeof import('@agent-device/platform-android/mechanics').runAdbShell
>[0];
type PlatformAdbExecutorOptions = NonNullable<Parameters<PlatformAdbExecutor>[1]>;

/** The provider the Android family installs its own scope over, read from the same mechanics. */
type PlatformAdbProvider = import('@agent-device/platform-android/mechanics').AndroidAdbProvider;

/**
 * The Android interactor operation this composition adds to the published facet: the family's own
 * factory, read while the capabilities are built so the operation can answer synchronously. Naming
 * the factory rather than spelling a signature keeps the device, provider and interactor types the
 * platform's own, so the value crosses unchanged.
 */
type AndroidInteractorFactory =
  typeof import('./core/interactors/android.ts').createAndroidInteractor;

/**
 * The Android facet as this composition builds and hands it over: the published contract's mechanics
 * plus the interactor operation. The operation is named here and not in the published contract
 * because an interactor cannot cross that surface: a plugin package bundles the contract into its own
 * declaration, and the snapshot answer the interactor produces carries a `unique symbol` brand no
 * other copy of that declaration answers to. A plugin reads the published mechanics; the root adapters
 * that answer `getInteractor` are composed in this process and read this operation from the value they
 * are handed, so a facet built by a composition that serves only the published contract is checked at
 * use.
 */
export type ProviderAndroidHostWithInteractor = ProviderAndroidHost &
  Readonly<{
    /**
     * Builds the Android interactor for `device`, with every one of its commands answered through
     * `adb`, which the platform scopes for `device.id` while the interactor runs. Returns
     * synchronously because the caller that needs it cannot await: `getInteractor` is synchronous, so
     * the factory was read while these capabilities were built and the value is assembled here with
     * no promise and no device state.
     */
    createInteractor(
      device: DeviceInfo,
      adb: ProviderAndroidAdbProvider | ProviderAndroidExecutor,
    ): ReturnType<AndroidInteractorFactory>;
  }>;

/** The capabilities this composition builds: the published facets with its own Android addition. */
export type ProviderHostCapabilitiesWithInteractor = ProviderHostCapabilities &
  Readonly<{ android: ProviderAndroidHostWithInteractor }>;

/**
 * The host capabilities the provider plugin registry adds to every plugin `setup` host, built by
 * `PROVIDER_PLUGIN_POLICY`. Each operation runs under `host`: commands resolve from its env/cwd,
 * so ambient process values never leak into a plugin's platform call. The facets expose the
 * existing platform owners; they add no platform behavior of their own. The composition root loads
 * them only when a plugin runtime is set up.
 *
 * The facet types mirror the platform's adb shapes structurally, so each method forwards its
 * arguments to the platform's mechanics and converts only the binary payloads, which the contract
 * names as plain byte arrays and the platform reads as Node buffers. `withAdbProvider` accepts the
 * facet's provider mirror, which the platform normalizes the same way as its own.
 *
 * The Apple facet carries the provider projection: the daemon's Apple shutdown members are absent
 * from its type and removed from the value, so a plugin's authority ends at the runner sessions its
 * own leases own. The daemon's durable-resource lifecycle keeps the full port.
 */
export async function createProviderHostCapabilities(
  host: HostEnvironment,
): Promise<ProviderHostCapabilitiesWithInteractor> {
  // The host adb port refuses an unbound host; this wiring binds it once and loads no device state.
  await import('./platform-runtime-android-adb-host.ts');
  // `getInteractor` is synchronous, so the family's interactor factory is read here, once, while
  // this host is wired. The Android family's mechanics are already in this process by then; nothing
  // is probed and no device state is read.
  const { createAndroidInteractor } = await import('./core/interactors/android.ts');
  const runOnHost = <T>(task: () => Promise<T>) =>
    withCommandHost({ host, requestEnv: undefined }, task);
  return Object.freeze({
    android: createProviderAndroidHost(runOnHost, createAndroidInteractor),
    apple: await createProviderAppleHost(host, runOnHost),
  } satisfies ProviderHostCapabilitiesWithInteractor);
}

async function createProviderAppleHost(
  host: HostEnvironment,
  runOnHost: <T>(task: () => Promise<T>) => Promise<T>,
): Promise<ProviderHostCapabilities['apple']> {
  const { createAppleApplicationTools } =
    await import('./platform-runtime-apple-application-tools.ts');
  // The projection runs first so the members are gone before anything is wrapped, and the scope
  // wrapper is read back into a plain frozen value: every call re-enters this host's command scope,
  // so the facet answers from `host` however deep the Apple mechanics go, and an enclosing request's
  // environment never rides along.
  const projected = availableAppleApplicationToolsForProvider(
    createAppleApplicationTools(host.env),
  );
  const scoped = withMethodScope({ ...projected }, runOnHost);
  return Object.freeze({
    applicationTools: Object.freeze({ ...scoped } satisfies AppleApplicationToolsForProvider),
  });
}

function createProviderAndroidHost(
  runOnHost: <T>(task: () => Promise<T>) => Promise<T>,
  buildInteractor: AndroidInteractorFactory,
): ProviderAndroidHostWithInteractor {
  return Object.freeze({
    runAdb: async (invocation, options) => {
      const { runAndroidHostAdb } = await import('@agent-device/platform-android/mechanics');
      return await runOnHost(() => runAndroidHostAdb(invocation, asPlatformAdbOptions(options)));
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
      return await runOnHost(
        async () => await withAndroidAdbProvider(asPlatformAdbProvider(provider), { serial }, task),
      );
    },
    runShell: async (adb, words, options) => {
      const { runAdbShell } = await import('@agent-device/platform-android/mechanics');
      return await runAdbShell(asPlatformAdbExecutor(adb), words, asPlatformAdbOptions(options));
    },
    createPortReverse: async (adb, options) => {
      const { createAndroidPortReverseManager } =
        await import('@agent-device/platform-android/mechanics');
      return createAndroidPortReverseManager(asPlatformAdbExecutor(adb), options);
    },
    listApps: async (adb, options) => {
      const { listAndroidAppsWithAdb } = await import('@agent-device/platform-android/mechanics');
      return await listAndroidAppsWithAdb(asPlatformAdbExecutor(adb), options);
    },
    readLogs: async (adb, options) => {
      const { captureAndroidLogcatWithAdb } =
        await import('@agent-device/platform-android/mechanics');
      return await captureAndroidLogcatWithAdb(asPlatformAdbExecutor(adb), options);
    },
    keyboardState: async (adb) => {
      const { getAndroidKeyboardStatusWithAdb } =
        await import('@agent-device/platform-android/mechanics');
      return await getAndroidKeyboardStatusWithAdb(asPlatformAdbExecutor(adb));
    },
    dismissKeyboard: async (adb) => {
      const { dismissAndroidKeyboardWithAdb } =
        await import('@agent-device/platform-android/mechanics');
      return await dismissAndroidKeyboardWithAdb(asPlatformAdbExecutor(adb));
    },
    // The factory is already loaded, so this method assembles the value and reaches for no module.
    // The scope wrapper is the one the Apple facet uses for the same reason: every command the
    // interactor runs re-enters this host's command scope, and the provider scope the factory
    // installed keeps those answers on the caller's executor for `device.id`.
    createInteractor: (device, adb) =>
      withMethodScope(
        buildInteractor(device, asPlatformAdbProvider(adb)),
        async (task) => await runOnHost(task),
      ),
  } satisfies ProviderAndroidHostWithInteractor);
}

/**
 * Reads the contract's execution options as the platform's own. The contract names a stdin payload
 * a plain byte array while the transport writes a Node buffer; a buffer is already a byte array, so
 * only a foreign array needs copying.
 */
function asPlatformAdbOptions(
  options: ProviderAndroidExecutorOptions | undefined,
): PlatformAdbExecutorOptions | undefined {
  if (options === undefined) return undefined;
  const { stdin, ...rest } = options;
  return {
    ...rest,
    ...(stdin === undefined ? {} : { stdin: Buffer.isBuffer(stdin) ? stdin : Buffer.from(stdin) }),
  };
}

/**
 * Hands a plugin's provider to the platform's mechanics. Only `exec` needs converting, for the
 * binary-answer reason below; the reverse manager and the text injector are the shapes the platform
 * reads them as, so they reach it as they are. The platform normalizes a bare executor exactly as a
 * provider carrying only `exec`.
 */
function asPlatformAdbProvider(
  provider: ProviderAndroidAdbProvider | ProviderAndroidExecutor,
): PlatformAdbProvider {
  return typeof provider === 'function'
    ? { exec: asPlatformAdbExecutor(provider) }
    : { ...provider, exec: asPlatformAdbExecutor(provider.exec) };
}

/**
 * Hands a plugin's executor to the platform's mechanics. The contract names the binary answer a
 * plain byte array while the platform's mechanics read it as a Node buffer, so an answer carrying
 * bytes the platform did not produce is copied into one. A buffer is already a byte array, so the
 * platform's own answers pass through untouched.
 */
function asPlatformAdbExecutor(adb: ProviderAndroidExecutor): PlatformAdbExecutor {
  return async (args, options) => {
    const { stdoutBuffer, ...text } = await adb(args, options);
    return {
      ...text,
      ...(stdoutBuffer === undefined
        ? {}
        : {
            stdoutBuffer: Buffer.isBuffer(stdoutBuffer) ? stdoutBuffer : Buffer.from(stdoutBuffer),
          }),
    };
  };
}
