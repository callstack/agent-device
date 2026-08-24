import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import { closeHarmonyApp, openHarmonyApp } from '../../platforms/harmonyos/app-lifecycle.ts';
import {
  appSwitcherHarmony,
  backHarmony,
  doubleClickHarmony,
  fillHarmony,
  homeHarmony,
  longPressHarmony,
  performHarmonyGesture,
  pressHarmony,
  pressHarmonyKeyboardKey,
  scrollHarmony,
  setHarmonyOrientation,
  typeHarmony,
} from '../../platforms/harmonyos/input-actions.ts';
import { screenshotHarmony } from '../../platforms/harmonyos/screenshot.ts';
import { setHarmonySetting } from '../../platforms/harmonyos/settings.ts';
import { readHarmonyGestureViewport, snapshotHarmony } from '../../platforms/harmonyos/snapshot.ts';

export function createHarmonyInteractor(device: DeviceInfo, _runner?: RunnerContext): Interactor {
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new AppError('UNSUPPORTED_OPERATION', `${name} is not supported on HarmonyOS`);
  };
  return {
    open: (app, options) => openHarmonyApp(device, app, { activity: options?.activity }),
    openDevice: () => homeHarmony(device),
    close: (app) => closeHarmonyApp(device, app),
    tap: (x, y) => pressHarmony(device, x, y),
    doubleTap: (x, y) => doubleClickHarmony(device, x, y),
    longPress: (x, y, durationMs) => longPressHarmony(device, x, y, durationMs),
    focus: (x, y) => pressHarmony(device, x, y),
    type: (text, delayMs) => typeHarmony(device, text, delayMs),
    fill: (x, y, text, delayMs) => fillHarmony(device, x, y, text, delayMs),
    scroll: (direction, options) => scrollHarmony(device, direction, options),
    performGesture: (plan) => performHarmonyGesture(device, plan),
    gestureViewport: () => readHarmonyGestureViewport(device),
    screenshot: (outPath) => screenshotHarmony(device, outPath),
    snapshot: async (options) => {
      const result = await withDiagnosticTimer(
        'snapshot_capture',
        async () => await snapshotHarmony(device, options),
        { backend: 'harmonyos-arkui' },
      );
      return { ...result, backend: 'harmonyos-arkui', producer: 'harmonyos-uitest' };
    },
    back: () => backHarmony(device),
    home: () => homeHarmony(device),
    setOrientation: (orientation) => setHarmonyOrientation(device, orientation),
    appSwitcher: () => appSwitcherHarmony(device),
    tvRemote: unsupported('tv-remote'),
    keyboardDismiss: async () => {
      await pressHarmonyKeyboardKey(device, 'Back');
      return { kind: 'acknowledged' };
    },
    keyboardEnter: async () => {
      await pressHarmonyKeyboardKey(device, 'Enter');
      return { kind: 'harmonyos-acknowledged' };
    },
    readClipboard: unsupported('clipboard'),
    writeClipboard: unsupported('clipboard'),
    setSetting: (setting, state, appId) => setHarmonySetting(device, setting, state, appId),
    // R59: the retired `alert` descriptor declared no HarmonyOS leaf, and hdc exposes no dialog
    // surface to read one from.
    readAlert: unsupported('alert'),
    awaitAlert: unsupported('alert'),
    acceptAlert: unsupported('alert'),
    dismissAlert: unsupported('alert'),
  };
}
