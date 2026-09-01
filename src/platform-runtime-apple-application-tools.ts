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

/** Lazy Apple tools; the Apple package owns lifecycle sequencing around these primitives. */
export function createAppleApplicationTools(): AppleApplicationTools {
  return Object.freeze({
    resolveOpenTarget: async (device, input) => await resolveAppleOpenTarget(device, input),
    prewarmRunnerCache: async (device, execution, signal) => {
      const { prewarmAppleRunnerCache } =
        await import('@agent-device/platform-apple/runner/operations');
      await prewarmAppleRunnerCache(device, appleRunnerOptions(execution, signal));
    },
    prewarmRunnerSession: async (
      device,
      execution,
      signal,
      propagateError,
      options?: AppleRunnerSessionPrewarmOptions,
    ) => {
      const { prewarmIosRunnerSession } =
        await import('@agent-device/platform-apple/runner/operations');
      await prewarmIosRunnerSession(device, {
        ...appleRunnerOptions(execution, signal),
        propagateError,
        ...options,
      });
    },
    notifyRunnerAppRelaunched: async (device, execution, signal) => {
      const { notifyIosRunnerAppRelaunched } =
        await import('@agent-device/platform-apple/runner/operations');
      await notifyIosRunnerAppRelaunched(device, appleRunnerOptions(execution, signal));
    },
    stopRunnerSession: async (deviceId) => {
      const { stopIosRunnerSession } =
        await import('@agent-device/platform-apple/runner/operations');
      await stopIosRunnerSession(deviceId);
    },
    scheduleRunnerIdleStop: (deviceId) => {
      void import('@agent-device/platform-apple/runner/operations').then(
        ({ scheduleIosRunnerIdleStop }) => scheduleIosRunnerIdleStop(deviceId),
      );
    },
    prepareRunner: async (device, input, signal) => {
      const { Deadline } = await import('@agent-device/host-kit/retry');
      const { prepareIosRunner } = await import('@agent-device/platform-apple/runner/operations');
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
      const { applyRuntimeHintValues } = await import('./platform-runtime-runtime-hints.ts');
      await applyRuntimeHintValues({ device, ...input });
    },
    clearRuntimeHints: async (device, input) => {
      const { clearRuntimeHintValues } = await import('./platform-runtime-runtime-hints.ts');
      await clearRuntimeHintValues({ device, ...input });
    },
    dismissCloseAlerts: async (device, input) => await dismissMacOsCloseAlerts(device, input),
    detachRunnerSessionsForShutdown: async () => {
      const { detachIosSimulatorRunnerSessionsForShutdown } =
        await import('@agent-device/platform-apple/runner/operations');
      await detachIosSimulatorRunnerSessionsForShutdown();
    },
    finalizeRunnerSessionsForShutdown: async () => {
      const { stopAllIosRunnerSessions } =
        await import('@agent-device/platform-apple/runner/operations');
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
  const { resolveSessionAppBundleIdForTarget } = await import('./platform-runtime-open-target.ts');
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
  const { detectSoleRunningIosSimulatorApp } =
    await import('@agent-device/platform-apple/app-resolution');
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
  const { resolveFrontmostMacOsApp } = await import('@agent-device/platform-apple/macos');
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
  const { runMacOsAlertAction } = await import('@agent-device/platform-apple/macos');
  const dismissOptions =
    input.surface === 'frontmost-app'
      ? { surface: 'frontmost-app' as const }
      : input.appBundleId
        ? { bundleId: input.appBundleId }
        : {};
  await runMacOsAlertAction('dismiss', dismissOptions);
}
