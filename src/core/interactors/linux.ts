import { AppError } from '../../kernel/errors.ts';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
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
  scrollLinux,
  swipeLinux,
  typeLinux,
} from '../../platforms/linux/input-actions.ts';
import { screenshotLinux } from '../../platforms/linux/screenshot.ts';
import { snapshotLinux } from '../../platforms/linux/snapshot.ts';
import type { Interactor } from '../interactor-types.ts';

export function createLinuxInteractor(): Interactor {
  return {
    open: (app) => openLinuxApp(app),
    openDevice: () => Promise.resolve(),
    close: (app) => closeLinuxApp(app),
    tap: (x, y) => pressLinux(x, y),
    doubleTap: (x, y) => doubleClickLinux(x, y),
    swipe: (x1, y1, x2, y2, durationMs) => swipeLinux(x1, y1, x2, y2, durationMs),
    pan: (x1, y1, x2, y2, durationMs) => swipeLinux(x1, y1, x2, y2, durationMs),
    fling: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'gesture fling not supported on Linux');
    },
    longPress: (x, y, durationMs) => longPressLinux(x, y, durationMs),
    focus: (x, y) => focusLinux(x, y),
    type: (text, delayMs) => typeLinux(text, delayMs),
    fill: (x, y, text, delayMs) => fillLinux(x, y, text, delayMs),
    scroll: (direction, options) => scrollLinux(direction, options),
    pinch: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'gesture pinch not supported on Linux');
    },
    screenshot: (outPath, options) => screenshotLinux(outPath, options),
    snapshot: async (options) => {
      const result = await withDiagnosticTimer(
        'snapshot_capture',
        async () => await snapshotLinux(options?.surface),
        { backend: 'linux-atspi' },
      );
      return {
        nodes: result.nodes ?? [],
        truncated: result.truncated ?? false,
        backend: 'linux-atspi',
      };
    },
    back: () => backLinux(),
    home: () => homeLinux(),
    rotate: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'rotate not supported on Linux');
    },
    rotateGesture: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'gesture rotate not supported on Linux');
    },
    transformGesture: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'gesture transform not supported on Linux');
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
  };
}
