import { AppError } from '@agent-device/kernel/errors';
import { singlePointerPlanEndpoints } from '@agent-device/gestures/gesture-plan';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { LinuxToolProvider } from './tool-provider-types.ts';
import { backLinux, closeLinuxApp, homeLinux, openLinuxApp } from './app-lifecycle.ts';
import { readLinuxClipboard, writeLinuxClipboard } from './clipboard.ts';
import {
  doubleClickLinux,
  fillLinux,
  focusLinux,
  longPressLinux,
  middleClickLinux,
  pressLinux,
  rightClickLinux,
  scrollLinux,
  swipeLinux,
  typeLinux,
} from './input-actions.ts';
import { readLinuxTextAtPoint } from './snapshot.ts';
import { captureLinuxSurfaceSnapshot } from './surface-snapshot.ts';
import { screenshotLinux } from './screenshot.ts';
import type { LinuxToolbox } from './toolbox.ts';

/**
 * The Linux interactor, bound to the toolbox the plugin was set up with and to the provider built on
 * it: the display decision lives on that instance, never in module state, so another runtime's host
 * cannot reach it (#3794). Every method uses that one provider — the family answers for its desktop
 * only through the host it was set up with.
 */
export function createLinuxInteractor(
  toolbox: LinuxToolbox,
  provider: LinuxToolProvider,
): Interactor {
  return {
    open: (app) => openLinuxApp(provider, app),
    openDevice: () => Promise.resolve(),
    close: (app) => closeLinuxApp(provider, app),
    tap: (x, y) => pressLinux(provider, x, y),
    alternateClick: async (point, button) =>
      button === 'secondary'
        ? await rightClickLinux(provider, point.x, point.y)
        : await middleClickLinux(provider, point.x, point.y),
    doubleTap: (x, y) => doubleClickLinux(provider, x, y),
    longPress: (x, y, durationMs) => longPressLinux(provider, x, y, durationMs),
    focus: (x, y) => focusLinux(provider, x, y),
    type: (text, delayMs) => typeLinux(provider, text, delayMs),
    fill: (x, y, text, delayMs) => fillLinux(provider, x, y, text, delayMs),
    scroll: (direction, options) => scrollLinux(provider, direction, options),
    performGesture: async (plan) => {
      if (plan.topology !== 'single') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Multi-touch gestures are not supported on Linux',
        );
      }
      const { start, end } = singlePointerPlanEndpoints(plan);
      await swipeLinux(provider, start.x, start.y, end.x, end.y, plan.durationMs);
    },
    screenshot: (outPath, options) => screenshotLinux(provider, outPath, options),
    // The Linux read is value-first (AXValue/title/description) where the captured tree is
    // label-first, so this genuinely reads differently from its snapshot text.
    readTextAtPoint: async (point, options) =>
      await readLinuxTextAtPoint(toolbox, provider, point.x, point.y, options?.surface),
    snapshot: async (options) =>
      await toolbox.withDiagnosticTimer(
        'snapshot_capture',
        async () => await captureLinuxSurfaceSnapshot(toolbox, provider, options, options?.signal),
        { backend: 'linux-atspi' },
      ),
    back: () => backLinux(provider),
    home: () => homeLinux(provider),
    setOrientation: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'orientation not supported on Linux');
    },
    appSwitcher: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'appSwitcher not yet supported on Linux');
    },
    tvRemote: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'tv-remote not supported on Linux');
    },
    readClipboard: () => readLinuxClipboard(provider),
    writeClipboard: (text) => writeLinuxClipboard(provider, text),
    setSetting: async () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'setSetting not supported on Linux');
    },
  };
}
