import type {
  AppleApplicationTools,
  AppleRunnerSessionPrewarmOptions,
  CloseApplicationFinalizationInput,
  OpenTargetResolution,
  OpenTargetResolutionInput,
  PrepareAppleRunnerInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { isIosFamily, isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';

/**
 * One memoized loader per lazily imported module, and the only way the ports below reach one.
 *
 * A port must never open its own `import(...)`: the open path deliberately leaves the runner
 * prewarm unawaited, so two ports routinely resolve the same specifier at the same time. In
 * production those duplicates are equivalent — the loader caches — but under Vitest they are
 * not: while a `vi.mock` factory is still awaiting `importOriginal()`, a second dynamic import
 * of that id resolves to the UNMOCKED module. A unit test's mocked runner then escapes into the
 * real local XCTest runner, whose stale-process cleanup `pkill`s xcodebuild on the developer's
 * host and fails whichever test happens to be running when it lands (#2314). Resolving each
 * specifier exactly once removes the second resolution that the escape needs.
 */
let runnerOperationsModule:
  | Promise<typeof import('@agent-device/platform-apple/runner/operations')>
  | undefined;
const loadRunnerOperations = () =>
  (runnerOperationsModule ??= import('@agent-device/platform-apple/runner/operations'));

let runtimeHintsModule: Promise<typeof import('./platform-runtime-runtime-hints.ts')> | undefined;
const loadRuntimeHints = () =>
  (runtimeHintsModule ??= import('./platform-runtime-runtime-hints.ts'));

let openTargetModule: Promise<typeof import('./platform-runtime-open-target.ts')> | undefined;
const loadOpenTarget = () => (openTargetModule ??= import('./platform-runtime-open-target.ts'));

let appResolutionModule:
  | Promise<typeof import('@agent-device/platform-apple/app-resolution')>
  | undefined;
const loadAppResolution = () =>
  (appResolutionModule ??= import('@agent-device/platform-apple/app-resolution'));

let macOsModule: Promise<typeof import('@agent-device/platform-apple/macos')> | undefined;
const loadMacOs = () => (macOsModule ??= import('@agent-device/platform-apple/macos'));

let retryModule: Promise<typeof import('@agent-device/host-kit/retry')> | undefined;
const loadRetry = () => (retryModule ??= import('@agent-device/host-kit/retry'));

/** Lazy Apple tools; the Apple package owns lifecycle sequencing around these primitives. */
export function createAppleApplicationTools(): AppleApplicationTools {
  return Object.freeze({
    resolveOpenTarget: async (device, input) => await resolveAppleOpenTarget(device, input),
    prewarmRunnerCache: async (device, execution, signal) => {
      const { prewarmAppleRunnerCache } = await loadRunnerOperations();
      await prewarmAppleRunnerCache(device, appleRunnerOptions(execution, signal));
    },
    prewarmRunnerSession: async (
      device,
      execution,
      signal,
      propagateError,
      options?: AppleRunnerSessionPrewarmOptions,
    ) => {
      const { prewarmIosRunnerSession } = await loadRunnerOperations();
      await prewarmIosRunnerSession(device, {
        ...appleRunnerOptions(execution, signal),
        propagateError,
        ...options,
      });
    },
    notifyRunnerAppRelaunched: async (device, execution, signal) => {
      const { notifyIosRunnerAppRelaunched } = await loadRunnerOperations();
      await notifyIosRunnerAppRelaunched(device, appleRunnerOptions(execution, signal));
    },
    stopRunnerSession: async (deviceId) => {
      const { stopIosRunnerSession } = await loadRunnerOperations();
      await stopIosRunnerSession(deviceId);
    },
    hasLiveRunnerSession: async (device, execution) => {
      const { hasLiveIosRunnerSession } =
        await import('@agent-device/platform-apple/runner/operations');
      return hasLiveIosRunnerSession(device, { requestId: execution.requestId });
    },
    scheduleRunnerIdleStop: (deviceId) => {
      void loadRunnerOperations().then(({ scheduleIosRunnerIdleStop }) =>
        scheduleIosRunnerIdleStop(deviceId),
      );
    },
    prepareRunner: async (device, input, signal) => {
      const { Deadline } = await loadRetry();
      const { prepareIosRunner } = await loadRunnerOperations();
      const startedAtMs = Date.now();
      return await prepareIosRunner(device, {
        ...appleRunnerOptions(input.execution, signal),
        cleanStaleBundles: true,
        buildTimeoutMs: input.timeoutMs,
        healthTimeoutMs: input.timeoutMs,
        prepareDeadline: Deadline.fromTimeoutMs(input.timeoutMs, startedAtMs),
        startupTimeoutMs: input.timeoutMs,
      });
    },
    applyRuntimeHints: async (device, input) => {
      const { applyRuntimeHintValues } = await loadRuntimeHints();
      await applyRuntimeHintValues({ device, ...input });
    },
    clearRuntimeHints: async (device, input) => {
      const { clearRuntimeHintValues } = await loadRuntimeHints();
      await clearRuntimeHintValues({ device, ...input });
    },
    dismissCloseAlerts: async (device, input) => await dismissMacOsCloseAlerts(device, input),
    detachRunnerSessionsForShutdown: async () => {
      const { detachIosSimulatorRunnerSessionsForShutdown } = await loadRunnerOperations();
      await detachIosSimulatorRunnerSessionsForShutdown();
    },
    finalizeRunnerSessionsForShutdown: async () => {
      const { stopAllIosRunnerSessions } = await loadRunnerOperations();
      await stopAllIosRunnerSessions();
    },
  });
}

async function resolveAppleOpenTarget(
  device: DeviceInfo,
  input: OpenTargetResolutionInput,
): Promise<OpenTargetResolution> {
  if (input.foreground) {
    const foreground = await resolveAppleForegroundTarget(device);
    if (foreground) return foreground;
    throw new AppError(
      'AMBIGUOUS_MATCH',
      'open --foreground requires exactly one running app on the selected iOS simulator.',
      {
        reason: 'foreground_app_ambiguous',
        hint: 'Pass an explicit app instead: agent-device open <app> --platform ios.',
      },
    );
  }
  const macOsSurface = await resolveMacOsSurface(device, input.surface);
  const { resolveSessionAppBundleIdForTarget } = await loadOpenTarget();
  return {
    appBundleId:
      macOsSurface.appBundleId ??
      (await resolveSessionAppBundleIdForTarget(
        device,
        input.target,
        input.currentAppBundleId,
        async () => undefined,
      )),
    appName: macOsSurface.appName ?? input.target,
  };
}

async function resolveAppleForegroundTarget(
  device: DeviceInfo,
): Promise<OpenTargetResolution | undefined> {
  if (!isIosFamily(device) || device.kind !== 'simulator') return undefined;
  const { detectSoleRunningIosSimulatorApp } = await loadAppResolution();
  const app = await detectSoleRunningIosSimulatorApp(device);
  return app ? { appBundleId: app.bundleId, appName: app.name } : undefined;
}

async function resolveMacOsSurface(
  device: DeviceInfo,
  surface: OpenTargetResolutionInput['surface'],
): Promise<OpenTargetResolution> {
  if (!isMacOs(device) || surface === 'app' || surface === 'desktop' || surface === 'menubar') {
    return {};
  }
  const { resolveFrontmostMacOsApp } = await loadMacOs();
  const frontmost = await resolveFrontmostMacOsApp();
  return { appBundleId: frontmost.bundleId, appName: frontmost.appName };
}

function appleRunnerOptions(execution: PrepareAppleRunnerInput['execution'], signal: AbortSignal) {
  return {
    requestId: execution.requestId,
    logPath: execution.logPath,
    traceLogPath: execution.traceLogPath,
    verbose: execution.verbose,
    iosXctestrunFile: execution.iosXctestrunFile,
    iosXctestDerivedDataPath: execution.iosXctestDerivedDataPath,
    iosXctestEnvDir: execution.iosXctestEnvDir,
    runnerLeaseContext: execution.runnerLeaseContext,
    signal,
  };
}

async function dismissMacOsCloseAlerts(
  device: DeviceInfo,
  input: CloseApplicationFinalizationInput,
): Promise<void> {
  if (!isMacOs(device)) return;
  const { runMacOsAlertAction } = await loadMacOs();
  const dismissOptions =
    input.surface === 'frontmost-app'
      ? { surface: 'frontmost-app' as const }
      : input.appBundleId
        ? { bundleId: input.appBundleId }
        : {};
  await runMacOsAlertAction('dismiss', dismissOptions);
}
