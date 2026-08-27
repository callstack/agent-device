import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import {
  backLinux,
  closeLinuxApp,
  homeLinux,
  openLinuxApp,
} from '../../platforms/linux/app-lifecycle.ts';
import { readLinuxClipboard, writeLinuxClipboard } from '../../platforms/linux/clipboard.ts';
import {
  doubleClickLinux,
  fillLinux,
  focusLinux,
  longPressLinux,
  pressLinux,
  rightClickLinux,
  middleClickLinux,
  scrollLinux,
  swipeLinux,
  typeLinux,
} from '../../platforms/linux/input-actions.ts';
import { singlePointerPlanEndpoints } from '@agent-device/contracts/gesture-plan';
import { screenshotLinux } from '../../platforms/linux/screenshot.ts';
import { captureLinuxSurfaceSnapshot } from '../../snapshot/snapshot-desktop-surface.ts';
import type { Interactor } from '@agent-device/contracts/interactor-types';

function unsupportedLinuxAlert(): Promise<never> {
  throw new AppError('UNSUPPORTED_OPERATION', 'alert not supported on Linux');
}

export function createLinuxInteractor(): Interactor {
  return {
    open: (app) => openLinuxApp(app),
    openDevice: () => Promise.resolve(),
    close: (app) => closeLinuxApp(app),
    tap: (x, y) => pressLinux(x, y),
    alternateClick: async (point, button) =>
      button === 'secondary'
        ? await rightClickLinux(point.x, point.y)
        : await middleClickLinux(point.x, point.y),
    doubleTap: (x, y) => doubleClickLinux(x, y),
    longPress: (x, y, durationMs) => longPressLinux(x, y, durationMs),
    focus: (x, y) => focusLinux(x, y),
    type: (text, delayMs) => typeLinux(text, delayMs),
    fill: (x, y, text, delayMs) => fillLinux(x, y, text, delayMs),
    scroll: (direction, options) => scrollLinux(direction, options),
    performGesture: async (plan) => {
      if (plan.topology === 'two') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Multi-touch gestures are not supported on Linux',
        );
      }
      const { start, end } = singlePointerPlanEndpoints(plan);
      await swipeLinux(start.x, start.y, end.x, end.y, plan.durationMs);
    },
    screenshot: (outPath, options) => screenshotLinux(outPath, options),
    // The Linux read is value-first (AXValue/title/description) where the captured tree is
    // label-first, so this genuinely reads differently from its snapshot text.
    readTextAtPoint: async (point, options) => {
      const { readLinuxTextAtPoint } = await import('../../platforms/linux/snapshot.ts');
      return await readLinuxTextAtPoint(point.x, point.y, options?.surface);
    },
    snapshot: async (options) => {
      return await withDiagnosticTimer(
        'snapshot_capture',
        async () => await captureLinuxSurfaceSnapshot(options, options?.signal),
        { backend: 'linux-atspi' },
      );
    },
    back: () => backLinux(),
    home: () => homeLinux(),
    setOrientation: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'orientation not supported on Linux');
    },
    appSwitcher: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'appSwitcher not yet supported on Linux');
    },
    tvRemote: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'tv-remote not supported on Linux');
    },
    readClipboard: () => readLinuxClipboard(),
    writeClipboard: (text) => writeLinuxClipboard(text),
    setSetting: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'setSetting not supported on Linux');
    },
    // R59: the retired `alert` descriptor declared `linux: {}`, so no Linux cell was admitted.
    readAlert: unsupportedLinuxAlert,
    awaitAlert: unsupportedLinuxAlert,
    acceptAlert: unsupportedLinuxAlert,
    dismissAlert: unsupportedLinuxAlert,
  };
}
