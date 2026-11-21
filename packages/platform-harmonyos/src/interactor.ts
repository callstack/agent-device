import { stampSnapshotIdentity } from '@agent-device/contracts/snapshot-producers';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import type { HarmonyToolbox } from './toolbox.ts';
import { closeHarmonyApp, openHarmonyApp } from './app-lifecycle.ts';
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
} from './input-actions.ts';
import { screenshotHarmony } from './screenshot.ts';
import { setHarmonySetting } from './settings.ts';
import { readHarmonyGestureViewport, snapshotHarmony } from './snapshot.ts';

export function createHarmonyInteractor(
  toolbox: HarmonyToolbox,
  device: DeviceInfo,
  _runner?: RunnerContext,
): Interactor {
  const { hdc } = toolbox;
  const unsupported = (name: string) => async (): Promise<never> => {
    throw new AppError('UNSUPPORTED_OPERATION', `${name} is not supported on HarmonyOS`);
  };
  return {
    open: (app, options) => openHarmonyApp(hdc, device, app, { activity: options?.activity }),
    openDevice: () => homeHarmony(hdc, device),
    close: (app) => closeHarmonyApp(hdc, device, app),
    tap: (x, y) => pressHarmony(hdc, device, x, y),
    doubleTap: (x, y) => doubleClickHarmony(hdc, device, x, y),
    longPress: (x, y, durationMs) => longPressHarmony(hdc, device, x, y, durationMs),
    focus: (x, y) => pressHarmony(hdc, device, x, y),
    type: (text, delayMs) => typeHarmony(hdc, device, text, delayMs),
    fill: (x, y, text, delayMs) => fillHarmony(hdc, device, x, y, text, delayMs),
    scroll: (direction, options) => scrollHarmony(hdc, device, direction, options),
    performGesture: (plan) => performHarmonyGesture(hdc, device, plan),
    gestureViewport: () => readHarmonyGestureViewport(hdc, device),
    screenshot: (outPath) => screenshotHarmony(hdc, device, outPath),
    snapshot: async (options) => {
      const result = await toolbox.withDiagnosticTimer(
        'snapshot_capture',
        async () => await snapshotHarmony(hdc, device, options),
        { backend: 'harmonyos-arkui' },
      );
      return stampSnapshotIdentity(result, {
        backend: 'harmonyos-arkui',
        producer: 'harmonyos-uitest',
      });
    },
    back: () => backHarmony(hdc, device),
    home: () => homeHarmony(hdc, device),
    setOrientation: (orientation) => setHarmonyOrientation(device, orientation),
    appSwitcher: () => appSwitcherHarmony(hdc, device),
    tvRemote: unsupported('tv-remote'),
    keyboardDismiss: async () => {
      await pressHarmonyKeyboardKey(hdc, device, 'Back');
      return { kind: 'acknowledged' };
    },
    keyboardEnter: async () => {
      await pressHarmonyKeyboardKey(hdc, device, 'Enter');
      return { kind: 'harmonyos-acknowledged' };
    },
    readClipboard: unsupported('clipboard'),
    writeClipboard: unsupported('clipboard'),
    setSetting: (setting, state, appId) => setHarmonySetting(hdc, device, setting, state, appId),
  };
}
