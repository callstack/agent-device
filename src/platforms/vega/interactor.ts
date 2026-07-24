import { closeVegaApp, openVegaApp, openVegaDevice } from './app-lifecycle.ts';
import { pressVegaTvRemote } from './input-actions.ts';
import { unsupportedVegaOperation } from './unsupported.ts';
import type { Interactor, RunnerContext } from '../../core/interactor-types.ts';
import type { DeviceInfo } from '../../kernel/device.ts';

export function createVegaInteractor(
  device: DeviceInfo,
  _runnerContext: RunnerContext,
): Interactor {
  return {
    open: async (app, options) => {
      assertVegaOpenSupported(app, options);
      await openVegaApp(device, app);
    },
    openDevice: () => openVegaDevice(device),
    close: (app) => closeVegaApp(device, app),
    tap: () => unsupportedVegaOperation('tap'),
    tapElementSelector: () => unsupportedVegaOperation('tapElementSelector'),
    doubleTap: () => unsupportedVegaOperation('doubleTap'),
    longPress: () => unsupportedVegaOperation('longPress'),
    focus: () => unsupportedVegaOperation('focus'),
    type: () => unsupportedVegaOperation('type'),
    fillElementSelector: () => unsupportedVegaOperation('fillElementSelector'),
    fill: () => unsupportedVegaOperation('fill'),
    scroll: () => unsupportedVegaOperation('scroll'),
    screenshot: () => unsupportedVegaOperation('screenshot'),
    setViewport: () => unsupportedVegaOperation('setViewport'),
    snapshot: () => unsupportedVegaOperation('snapshot'),
    gestureViewport: () => unsupportedVegaOperation('gestureViewport'),
    back: () => pressVegaTvRemote(device, 'back'),
    home: () => pressVegaTvRemote(device, 'home'),
    setOrientation: () => unsupportedVegaOperation('setOrientation'),
    performGesture: () => unsupportedVegaOperation('performGesture'),
    appSwitcher: () => unsupportedVegaOperation('appSwitcher'),
    tvRemote: (button, durationMs) => pressVegaTvRemote(device, button, durationMs),
    readClipboard: () => unsupportedVegaOperation('readClipboard'),
    writeClipboard: () => unsupportedVegaOperation('writeClipboard'),
    setSetting: () => unsupportedVegaOperation('setSetting'),
  };
}

function assertVegaOpenSupported(app: string, options?: Parameters<Interactor['open']>[1]): void {
  const unsupportedVariant = [
    isDeepLinkTarget(app),
    Boolean(options?.url),
    Boolean(options?.activity),
    Boolean(options?.launchConsole),
    Boolean(options?.terminateRunningApp),
    Boolean(options?.launchArgs?.length),
  ].some(Boolean);
  if (!unsupportedVariant) return;
  throw new AppError(
    'UNSUPPORTED_OPERATION',
    'Vega open currently supports installed app component IDs only.',
    {
      hint: 'Use open <component-id> without a URL, activity, launch arguments, or launch-console options.',
    },
  );
}
import { isDeepLinkTarget } from '../../contracts/open-target.ts';
import { AppError } from '../../kernel/errors.ts';
