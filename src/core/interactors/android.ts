import {
  closeAndroidApp,
  openAndroidApp,
  openAndroidDevice,
} from '../../platforms/android/app-lifecycle.ts';
import {
  appSwitcherAndroid,
  backAndroid,
  fillAndroid,
  focusAndroid,
  homeAndroid,
  longPressAndroid,
  pressAndroid,
  pressAndroidTvRemote,
  scrollAndroid,
  setAndroidOrientation,
  typeAndroid,
} from '../../platforms/android/input-actions.ts';
import {
  executeAndroidTouchPlan,
  readAndroidGestureViewport,
} from '../../platforms/android/touch-executor.ts';
import {
  withAndroidAdbProvider,
  type AndroidAdbProvider,
} from '../../platforms/android/adb-executor.ts';
import {
  readAndroidClipboardText,
  writeAndroidClipboardText,
} from '../../platforms/android/device-input-state.ts';
import { setAndroidSetting } from '../../platforms/android/settings.ts';
import { snapshotAndroid } from '../../platforms/android/snapshot.ts';
import { screenshotAndroid } from '../../platforms/android/screenshot.ts';
import { withDiagnosticTimer } from '../../utils/diagnostics.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { Interactor } from '../interactor-types.ts';
import { snapshotCaptureAnnotationsFrom } from '../../snapshot-capture-annotations.ts';

export function createAndroidInteractor(
  device: DeviceInfo,
  provider?: AndroidAdbProvider,
): Interactor {
  const interactor: Interactor = {
    open: (app, options) =>
      openAndroidApp(device, app, {
        activity: options?.activity,
        appBundleId: options?.appBundleId,
        launchArgs: options?.launchArgs,
        url: options?.url,
      }),
    openDevice: () => openAndroidDevice(device),
    close: (app) => closeAndroidApp(device, app),
    tap: (x, y) => pressAndroid(device, x, y),
    doubleTap: async (x, y) => {
      await pressAndroid(device, x, y);
      await pressAndroid(device, x, y);
    },
    longPress: (x, y, durationMs) => longPressAndroid(device, x, y, durationMs),
    focus: (x, y) => focusAndroid(device, x, y),
    type: (text, delayMs) => typeAndroid(device, text, delayMs),
    fill: (x, y, text, delayMs) => fillAndroid(device, x, y, text, delayMs),
    scroll: (direction, options) => scrollAndroid(device, direction, options),
    performGesture: (plan) => executeAndroidTouchPlan(device, plan),
    gestureViewport: () => readAndroidGestureViewport(device),
    screenshot: (outPath, options) => screenshotAndroid(device, outPath, options),
    snapshot: async (options) => {
      const result = await withDiagnosticTimer(
        'snapshot_capture',
        async () =>
          await snapshotAndroid(device, {
            appBundleId: options?.appBundleId,
            interactiveOnly: options?.interactiveOnly,
            depth: options?.depth,
            scope: options?.scope,
            raw: options?.raw,
            includeHiddenContentHints: options?.includeHiddenContentHints,
            // appBundleId is present for app-backed daemon sessions; keep the helper warm there,
            // but release it after standalone device snapshots so UiAutomation is not squatted.
            helperSessionScope: options?.appBundleId ? 'daemon-session' : 'command',
          }),
        { backend: 'android' },
      );
      return {
        nodes: result.nodes ?? [],
        truncated: result.truncated ?? false,
        backend: 'android',
        ...snapshotCaptureAnnotationsFrom(result),
      };
    },
    back: (_mode) => backAndroid(device),
    home: () => homeAndroid(device),
    setOrientation: (orientation) => setAndroidOrientation(device, orientation),
    appSwitcher: () => appSwitcherAndroid(device),
    tvRemote: (button, durationMs) => pressAndroidTvRemote(device, button, durationMs),
    readClipboard: () => readAndroidClipboardText(device),
    writeClipboard: (text) => writeAndroidClipboardText(device, text),
    setSetting: (setting, state, appId, options) =>
      setAndroidSetting(device, setting, state, appId, options),
  };
  if (!provider) return interactor;
  return new Proxy(interactor, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) =>
        withAndroidAdbProvider(
          provider,
          { serial: device.id },
          async () => await value.apply(target, args),
        );
    },
  });
}
