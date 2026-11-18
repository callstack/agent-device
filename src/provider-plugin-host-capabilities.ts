import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { withCommandHost } from '@agent-device/host-kit/command';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import type { AppleApplicationToolsForProvider } from '@agent-device/contracts/application-lifecycle-runtime';
import { availableAppleApplicationToolsForProvider } from '@agent-device/contracts/application-lifecycle-runtime';
import type {
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
): Promise<ProviderHostCapabilities> {
  // The host adb port refuses an unbound host; this wiring binds it once and loads no device state.
  await import('./platform-runtime-android-adb-host.ts');
  const runOnHost = <T>(task: () => Promise<T>) =>
    withCommandHost({ host, requestEnv: undefined }, task);
  return Object.freeze({
    android: createProviderAndroidHost(runOnHost),
    apple: await createProviderAppleHost(host, runOnHost),
  } satisfies ProviderHostCapabilities);
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
): ProviderAndroidHost {
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
      // The facet mirror is a structural subset of the platform provider; the platform
      // normalizes a bare executor exactly as a provider carrying only `exec`.
      const scoped =
        typeof provider === 'function'
          ? asPlatformAdbExecutor(provider)
          : { ...provider, exec: asPlatformAdbExecutor(provider.exec) };
      return await runOnHost(() => withAndroidAdbProvider(scoped, { serial }, task));
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
  } satisfies ProviderAndroidHost);
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
