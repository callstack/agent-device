import { AppError } from '@agent-device/kernel/errors';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import { singlePointerPlanEndpoints } from '@agent-device/gestures/gesture-plan';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { LinuxToolProvider } from '@agent-device/contracts/linux-tool-provider';
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
import {
  hasScopedLinuxToolProvider,
  resolveLinuxToolProvider,
  withLinuxToolProvider,
} from './tool-provider.ts';
import type { LinuxToolbox } from './toolbox.ts';

/**
 * The Linux interactor, bound to the toolbox the plugin was set up with and to the provider built on
 * it: the display decision lives on that instance, never in module state, so another runtime's host
 * cannot reach it (#3794). A request that scoped its own provider still wins — its scope is already
 * entered when the daemon dispatches, so the interactor's provider enters only for a request that
 * scoped none. Each method then resolves the provider in scope.
 */
export function createLinuxInteractor(
  toolbox: LinuxToolbox,
  provider: LinuxToolProvider,
): Interactor {
  const body = createLinuxInteractorBody(toolbox, provider);
  return withMethodScope(body, async (task) =>
    hasScopedLinuxToolProvider() ? await task() : await withLinuxToolProvider(provider, task),
  );
}

function createLinuxInteractorBody(
  toolbox: LinuxToolbox,
  own: LinuxToolProvider,
): Interactor {
  // Resolved per method rather than once at construction: the request scope is entered for the
  // method, and its provider is the one that must answer.
  const running = () => resolveLinuxToolProvider(own);
  return {
    open: (app) => openLinuxApp(running(), app),
    openDevice: () => Promise.resolve(),
    close: (app) => closeLinuxApp(running(), app),
    tap: (x, y) => pressLinux(running(), x, y),
    alternateClick: async (point, button) =>
      button === 'secondary'
        ? await rightClickLinux(running(), point.x, point.y)
        : await middleClickLinux(running(), point.x, point.y),
    doubleTap: (x, y) => doubleClickLinux(running(), x, y),
    longPress: (x, y, durationMs) => longPressLinux(running(), x, y, durationMs),
    focus: (x, y) => focusLinux(running(), x, y),
    type: (text, delayMs) => typeLinux(running(), text, delayMs),
    fill: (x, y, text, delayMs) => fillLinux(running(), x, y, text, delayMs),
    scroll: (direction, options) => scrollLinux(running(), direction, options),
    performGesture: async (plan) => {
      if (plan.topology !== 'single') {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          'Multi-touch gestures are not supported on Linux',
        );
      }
      const { start, end } = singlePointerPlanEndpoints(plan);
      await swipeLinux(running(), start.x, start.y, end.x, end.y, plan.durationMs);
    },
    screenshot: (outPath, options) => screenshotLinux(running(), outPath, options),
    // The Linux read is value-first (AXValue/title/description) where the captured tree is
    // label-first, so this genuinely reads differently from its snapshot text.
    readTextAtPoint: async (point, options) =>
      await readLinuxTextAtPoint(toolbox, running(), point.x, point.y, options?.surface),
    snapshot: async (options) =>
      await toolbox.withDiagnosticTimer(
        'snapshot_capture',
        async () => await captureLinuxSurfaceSnapshot(toolbox, running(), options, options?.signal),
        { backend: 'linux-atspi' },
      ),
    back: () => backLinux(running()),
    home: () => homeLinux(running()),
    setOrientation: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'orientation not supported on Linux');
    },
    appSwitcher: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'appSwitcher not yet supported on Linux');
    },
    tvRemote: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'tv-remote not supported on Linux');
    },
    readClipboard: () => readLinuxClipboard(running()),
    writeClipboard: (text) => writeLinuxClipboard(running(), text),
    setSetting: () => {
      throw new AppError('UNSUPPORTED_OPERATION', 'setSetting not supported on Linux');
    },
  };
}
