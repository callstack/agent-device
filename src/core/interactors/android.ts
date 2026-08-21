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
import { withMethodScope } from '../../utils/method-scope.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interaction';
import {
  copySnapshotClickabilityEvidence,
  snapshotCaptureAnnotationsFrom,
} from '@agent-device/contracts/capture';

export function createAndroidInteractor(
  device: DeviceInfo,
  provider?: AndroidAdbProvider,
  runnerContext?: Pick<RunnerContext, 'signal'>,
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
    // uiautomator reads the node covering a point; `undefined` means nothing covers it.
    readTextAtPoint: async (point) => {
      const { readAndroidTextAtPoint } = await import('../../platforms/android/input-actions.ts');
      return (await readAndroidTextAtPoint(device, point.x, point.y)) ?? undefined;
    },
    snapshot: async (options) => {
      const snapshotOptions = options ?? {};
      const result = await withDiagnosticTimer(
        'snapshot_capture',
        async () =>
          await snapshotAndroid(device, {
            appBundleId: snapshotOptions.appBundleId,
            signal: snapshotOptions.signal ?? runnerContext?.signal,
            interactiveOnly: snapshotOptions.interactiveOnly,
            depth: snapshotOptions.depth,
            scope: snapshotOptions.scope,
            raw: snapshotOptions.raw,
            includeHiddenContentHints: snapshotOptions.includeHiddenContentHints,
            // appBundleId is present for app-backed daemon sessions; keep the helper warm there,
            // but release it after standalone device snapshots so UiAutomation is not squatted.
            helperSessionScope: snapshotOptions.appBundleId ? 'daemon-session' : 'command',
          }),
        { backend: 'android' },
      );
      return copySnapshotClickabilityEvidence(result, {
        nodes: result.nodes ?? [],
        truncated: result.truncated ?? false,
        backend: 'android',
        ...snapshotCaptureAnnotationsFrom(result),
      });
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
  return withMethodScope(interactor, (task) =>
    withAndroidAdbProvider(provider, { serial: device.id }, task),
  );
}
