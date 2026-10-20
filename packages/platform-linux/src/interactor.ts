import { AppError } from '@agent-device/kernel/errors';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  createLocalLinuxToolProvider,
  hasScopedLinuxToolProvider,
  withLinuxToolProvider,
} from './tool-provider.ts';
import {
  backLinux,
  captureLinuxSurfaceSnapshot,
  closeLinuxApp,
  doubleClickLinux,
  fillLinux,
  focusLinux,
  homeLinux,
  longPressLinux,
  middleClickLinux,
  openLinuxApp,
  pressLinux,
  rightClickLinux,
  readLinuxClipboard,
  readLinuxTextAtPoint,
  scrollLinux,
  screenshotLinux,
  swipeLinux,
  typeLinux,
  writeLinuxClipboard,
} from './index.ts';
import { singlePointerPlanEndpoints } from '@agent-device/contracts/gesture-plan';
import type { Interactor } from '@agent-device/contracts/interactor-types';

export function createLinuxInteractor(host: HostEnvironment): Interactor {
  // The interactor builds its own provider over the composing runtime's host: the display
  // decision lives on that instance, never in module state, so another runtime's host cannot
  // reach it (#3794). A request-scoped provider still wins: this one enters only when the
  // request scopes none.
  const provider = createLocalLinuxToolProvider({ host });
  return withMethodScope(createLinuxInteractorBody(), async (task) =>
    hasScopedLinuxToolProvider() ? await task() : await withLinuxToolProvider(provider, task),
  );
}

function createLinuxInteractorBody(): Interactor {
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
      if (plan.topology !== 'single') {
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
  };
}
