import {
  closeIosApp,
  openIosApp,
  openIosDevice,
  readIosClipboardText,
  screenshotIos,
  setIosSetting,
  writeIosClipboardText,
} from './core/apps.ts';
import { captureScreenshotViaRunner } from './core/screenshot.ts';
import { iosRunnerOverrides, resolveAppleBackRunnerCommand } from './interactions.ts';
import { appleRemotePressCommand } from './os/tvos/remote.ts';
import { runMacOsScreenshotAction } from './os/macos/helper.ts';
import { runAppleRunnerCommand } from './core/runner/runner-client.ts';
import {
  withAppleRunnerProvider,
  type AppleRunnerCommandExecutor,
  type AppleRunnerProvider,
} from './core/runner/runner-provider.ts';
import { toAppleTvRemoteButton } from '@agent-device/contracts/interaction';
import { DEVICE_ROTATIONS, type DeviceRotation } from '@agent-device/contracts/device';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { isMacOs, isTvOsDevice, type DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { withMethodScope } from '../../utils/method-scope.ts';
import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';
import type {
  Interactor,
  RunnerCallOptions,
  RunnerContext,
  ScreenshotOptions,
} from '@agent-device/contracts/interaction';
import {
  readSnapshotQualityVerdict,
  type SnapshotQualityVerdict,
} from '../../snapshot/snapshot-quality.ts';

export function createAppleInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
  runnerProvider?: AppleRunnerProvider | AppleRunnerCommandExecutor,
): Interactor {
  // watchOS unsupported sentinel: XCUITest cannot drive watchOS UI (no
  // XCUIApplication), so a watchOS device has no runner backend. Reject it
  // explicitly here rather than letting `appleOs: 'watchos'` silently fall
  // through to the iOS runner profile (see resolveRunnerPlatformNameForAppleOs).
  if (device.appleOs === 'watchos') {
    throw new AppError(
      'UNSUPPORTED_PLATFORM',
      'watchOS is not supported: XCUITest cannot drive watchOS UI, so this device has no runner backend.',
    );
  }
  const { overrides, runnerOpts } = iosRunnerOverrides(device, runnerContext);
  const interactor: Interactor = {
    open: (app, options) =>
      openIosApp(device, app, {
        appBundleId: options?.appBundleId,
        launchConsole: options?.launchConsole,
        launchArgs: options?.launchArgs,
        terminateRunningApp: options?.terminateRunningApp,
        url: options?.url,
        runnerOptions: runnerOpts,
      }),
    openDevice: () => openIosDevice(device),
    close: (app) => closeIosApp(device, app, runnerOpts),
    screenshot: (outPath, options) => runAppleScreenshot(device, outPath, options, runnerOpts),
    snapshot: async (options) => {
      const result = readAppleSnapshotResult(
        await withDiagnosticTimer(
          'snapshot_capture',
          async () =>
            await runAppleRunnerCommand(
              device,
              {
                command: 'snapshot',
                appBundleId: options?.appBundleId,
                interactiveOnly: options?.interactiveOnly,
                depth: options?.depth,
                scope: options?.scope,
                raw: options?.raw,
              },
              mergeRunnerCallSignal(runnerOpts, options?.signal),
            ),
          { backend: 'xctest' },
        ),
      );
      const nodes = result.nodes ?? [];
      if (nodes.length === 0 && device.kind === 'simulator') {
        throw new AppError('COMMAND_FAILED', 'XCTest snapshot returned 0 nodes on iOS simulator.');
      }
      return {
        nodes,
        truncated: result.truncated ?? false,
        backend: 'xctest',
        ...(result.quality ? { quality: result.quality } : {}),
        // Legacy runners without a quality verdict still surface their message text.
        ...(!result.quality && result.message ? { warnings: [result.message] } : {}),
      };
    },
    back: async (mode) => {
      if (isTvOsDevice(device)) {
        // tvOS focus-only navigation: the Menu button pops focus, not a coordinate tap.
        await runAppleRunnerCommand(
          device,
          appleRemotePressCommand('menu', runnerContext.appBundleId),
          runnerOpts,
        );
        return;
      }
      await runAppleRunnerCommand(
        device,
        {
          command: resolveAppleBackRunnerCommand(mode),
          appBundleId: runnerContext.appBundleId,
        },
        runnerOpts,
      );
    },
    home: async () => {
      if (isTvOsDevice(device)) {
        // tvOS focus-only navigation: the Home button drives the remote, not a tap.
        await runAppleRunnerCommand(
          device,
          appleRemotePressCommand('home', runnerContext.appBundleId),
          runnerOpts,
        );
        return;
      }
      await runAppleRunnerCommand(
        device,
        { command: 'home', appBundleId: runnerContext.appBundleId },
        runnerOpts,
      );
    },
    setOrientation: async (orientation) => {
      const result = await runAppleRunnerCommand(
        device,
        // `rotate` is the runner-protocol command name (its own namespace); the
        // CLI-facing command/method is `orientation`.
        { command: 'rotate', orientation, appBundleId: runnerContext.appBundleId },
        runnerOpts,
      );
      const observed = readRunnerOrientation(result);
      if (observed !== orientation) {
        throw new AppError(
          'COMMAND_FAILED',
          `iOS runner observed ${observed} after requesting ${orientation}`,
          { requestedOrientation: orientation, observedOrientation: observed },
        );
      }
      return { orientation: observed };
    },
    appSwitcher: async () => {
      await runAppleRunnerCommand(
        device,
        { command: 'appSwitcher', appBundleId: runnerContext.appBundleId },
        runnerOpts,
      );
    },
    tvRemote: async (button, durationMs) => {
      await runAppleRunnerCommand(
        device,
        appleRemotePressCommand(
          toAppleTvRemoteButton(button),
          runnerContext.appBundleId,
          durationMs,
        ),
        runnerOpts,
      );
    },
    readClipboard: () => readIosClipboardText(device),
    writeClipboard: (text) => writeIosClipboardText(device, text),
    setSetting: (setting, state, appId, options) =>
      setIosSetting(device, setting, state, appId, options),
    ...overrides,
  };
  if (!runnerProvider) return interactor;
  return withInjectedAppleRunnerTransport(device, runnerContext, interactor, runnerProvider);
}

function mergeRunnerCallSignal(
  options: RunnerCallOptions,
  signal: AbortSignal | undefined,
): RunnerCallOptions {
  if (!signal) return options;
  return {
    ...options,
    signal: options.signal ? AbortSignal.any([options.signal, signal]) : signal,
  };
}

function readRunnerOrientation(result: Record<string, unknown>): DeviceRotation {
  const orientation = result.orientation;
  if (typeof orientation === 'string' && DEVICE_ROTATIONS.includes(orientation as DeviceRotation)) {
    return orientation as DeviceRotation;
  }
  throw new AppError('COMMAND_FAILED', 'iOS runner returned an invalid orientation result', {
    orientation,
  });
}

/**
 * Partitions the interactor for an injected provider transport. Its unique
 * jobs are the local-tooling rejection and in-process scoping for interactors
 * composed OUTSIDE a daemon request (on daemon requests the request-boundary
 * `appleRunnerProvider` resolver scopes the same transport around everything):
 * runner-command methods run inside the provider scope, while methods backed
 * by local Apple tooling (simctl/devicectl) have no provider-neutral transport
 * and fail fast until the provider session composes its own on top.
 */
function withInjectedAppleRunnerTransport(
  device: DeviceInfo,
  runnerContext: RunnerContext,
  interactor: Interactor,
  runnerProvider: AppleRunnerProvider | AppleRunnerCommandExecutor,
): Interactor {
  const providerInteractor: Interactor = {
    ...interactor,
    open: async () => rejectLocalAppleToolMethod('open'),
    openDevice: async () => rejectLocalAppleToolMethod('openDevice'),
    close: async () => rejectLocalAppleToolMethod('close'),
    screenshot: async () => rejectLocalAppleToolMethod('screenshot'),
    readClipboard: async () => rejectLocalAppleToolMethod('readClipboard'),
    writeClipboard: async () => rejectLocalAppleToolMethod('writeClipboard'),
    setSetting: async () => rejectLocalAppleToolMethod('setSetting'),
  };
  return withMethodScope(providerInteractor, (task) =>
    withAppleRunnerProvider(
      runnerProvider,
      { deviceId: device.id, requestId: runnerContext.requestId },
      task,
    ),
  );
}

function rejectLocalAppleToolMethod(method: string): never {
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    `${method} uses local Apple tooling (simctl/devicectl), which an injected runner transport cannot reach; the provider session must supply its own ${method} implementation.`,
  );
}

async function runAppleScreenshot(
  device: DeviceInfo,
  outPath: string,
  options: ScreenshotOptions = {},
  runnerOpts: RunnerCallOptions,
): Promise<void> {
  if (usesMacOsSurfaceScreenshot(device, options.surface)) {
    await runMacOsScreenshotAction(outPath, {
      surface: options.surface,
      fullscreen: options.fullscreen,
    });
    return;
  }
  if (options.captureBackend === 'runner') {
    // Runner capture returns the XCTest surface as-is; density and simulator
    // status-bar normalization belong only to the simctl capture pipeline.
    await captureScreenshotViaRunner(
      device,
      outPath,
      options.appBundleId,
      options.fullscreen,
      runnerOpts,
    );
    return;
  }
  await screenshotIos(device, outPath, {
    appBundleId: options.appBundleId,
    pixelDensity: options.pixelDensity,
    fullscreen: options.fullscreen,
    runnerOptions: runnerOpts,
    normalizeStatusBar: options.normalizeStatusBar,
    skipIosSimulatorBootCheck: options.skipIosSimulatorBootCheck,
  });
}

function usesMacOsSurfaceScreenshot(
  device: DeviceInfo,
  surface: ScreenshotOptions['surface'],
): surface is Exclude<ScreenshotOptions['surface'], undefined | 'app'> {
  return isMacOs(device) && surface !== undefined && surface !== 'app';
}

function readAppleSnapshotResult(result: Record<string, unknown>): {
  nodes?: RawSnapshotNode[];
  truncated?: boolean;
  message?: string;
  quality?: SnapshotQualityVerdict;
} {
  return {
    nodes: Array.isArray(result.nodes) ? (result.nodes as RawSnapshotNode[]) : undefined,
    truncated: typeof result.truncated === 'boolean' ? result.truncated : undefined,
    quality: readSnapshotQualityVerdict(result.snapshotQuality),
    // Legacy runner context for builds that predate the structured verdict.
    message:
      typeof result.message === 'string' && result.message.trim().length > 0
        ? result.message
        : undefined,
  };
}
