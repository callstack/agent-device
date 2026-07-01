import {
  closeIosApp,
  openIosApp,
  openIosDevice,
  readIosClipboardText,
  screenshotIos,
  setIosSetting,
  writeIosClipboardText,
} from './core/apps.ts';
import { iosRunnerOverrides, resolveAppleBackRunnerCommand } from './interactions.ts';
import { appleRemotePressCommand } from './os/tvos/remote.ts';
import { runMacOsScreenshotAction } from './os/macos/helper.ts';
import { runAppleRunnerCommand } from './core/runner/runner-client.ts';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { isMacOs, isTvOsDevice, type DeviceInfo } from '../../kernel/device.ts';
import { AppError } from '../../kernel/errors.ts';
import type { RawSnapshotNode } from '../../kernel/snapshot.ts';
import type { Interactor, RunnerContext } from '../../core/interactor-types.ts';
import {
  readSnapshotQualityVerdict,
  type SnapshotQualityVerdict,
} from '../../snapshot/snapshot-quality.ts';

export function createAppleInteractor(
  device: DeviceInfo,
  runnerContext: RunnerContext,
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
  return {
    open: (app, options) =>
      openIosApp(device, app, {
        appBundleId: options?.appBundleId,
        launchConsole: options?.launchConsole,
        launchArgs: options?.launchArgs,
        url: options?.url,
      }),
    openDevice: () => openIosDevice(device),
    close: (app) => closeIosApp(device, app),
    screenshot: async (outPath, options) => {
      if (isMacOs(device) && options?.surface && options.surface !== 'app') {
        await runMacOsScreenshotAction(outPath, {
          surface: options.surface,
          fullscreen: options.fullscreen,
        });
        return;
      }
      await screenshotIos(device, outPath, {
        appBundleId: options?.appBundleId,
        fullscreen: options?.fullscreen,
        runnerOptions: runnerOpts,
        normalizeStatusBar: options?.normalizeStatusBar,
        skipIosSimulatorBootCheck: options?.skipIosSimulatorBootCheck,
      });
    },
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
              runnerOpts,
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
    rotate: async (orientation) => {
      await runAppleRunnerCommand(
        device,
        { command: 'rotate', orientation, appBundleId: runnerContext.appBundleId },
        runnerOpts,
      );
    },
    appSwitcher: async () => {
      await runAppleRunnerCommand(
        device,
        { command: 'appSwitcher', appBundleId: runnerContext.appBundleId },
        runnerOpts,
      );
    },
    readClipboard: () => readIosClipboardText(device),
    writeClipboard: (text) => writeIosClipboardText(device, text),
    setSetting: (setting, state, appId, options) =>
      setIosSetting(device, setting, state, appId, options),
    ...overrides,
  };
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
