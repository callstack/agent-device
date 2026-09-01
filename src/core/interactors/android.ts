import '../../platform-runtime-android-adb-host.ts';
import {
  appSwitcherAndroid,
  androidSnapshotPublicationInput,
  backAndroid,
  closeAndroidApp,
  dismissAndroidKeyboard,
  executeAndroidTouchPlan,
  fillAndroid,
  focusAndroid,
  getAndroidKeyboardState,
  handleAndroidAlert,
  homeAndroid,
  longPressAndroid,
  openAndroidApp,
  openAndroidDevice,
  pressAndroid,
  pressAndroidEnter,
  pressAndroidTvRemote,
  readAndroidClipboardText,
  readAndroidGestureViewport,
  scrollAndroid,
  screenshotAndroid,
  setAndroidOrientation,
  setAndroidSetting,
  snapshotAndroid,
  typeAndroid,
  withAndroidAdbProvider,
  writeAndroidClipboardText,
  type AndroidAdbProvider,
  type AndroidHelperSessionScope,
} from '@agent-device/platform-android/mechanics';
import { withDiagnosticTimer } from '@agent-device/host-kit/diagnostics';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Interactor, RunnerContext } from '@agent-device/contracts/interactor-types';
import { buildSnapshotState } from '../snapshot-state.ts';

/**
 * `appBundleId` is present exactly for app-backed daemon sessions, whose teardown releases the
 * helper. Standalone device work has no such owner, so it releases the helper per command and
 * leaves nothing squatting UiAutomation.
 */
function androidHelperSessionScope(appBundleId: string | undefined): AndroidHelperSessionScope {
  return appBundleId ? 'daemon-session' : 'command';
}

export function createAndroidInteractor(
  device: DeviceInfo,
  provider?: AndroidAdbProvider,
  runnerContext?: Pick<RunnerContext, 'signal' | 'appBundleId'>,
): Interactor {
  const helperSessionScope = androidHelperSessionScope(runnerContext?.appBundleId);
  const alertOptions = (timeoutMs?: number) => ({
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    captureNodes: async () => {
      const capture = await snapshotAndroid(device, { includeHiddenContentHints: false });
      return buildSnapshotState(androidSnapshotPublicationInput(capture), undefined).nodes;
    },
  });
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
    fill: (x, y, text, delayMs) => fillAndroid(device, x, y, text, delayMs, { helperSessionScope }),
    scroll: (direction, options) =>
      scrollAndroid(device, direction, { ...options, helperSessionScope }),
    performGesture: (plan) => executeAndroidTouchPlan(device, plan),
    gestureViewport: () => readAndroidGestureViewport(device, { helperSessionScope }),
    screenshot: (outPath, options) => screenshotAndroid(device, outPath, options),
    // uiautomator reads the node covering a point; `undefined` means nothing covers it.
    readTextAtPoint: async (point, options) => {
      const { readAndroidTextAtPoint } = await import('@agent-device/platform-android/mechanics');
      const read = await readAndroidTextAtPoint(device, point.x, point.y, {
        helperSessionScope: androidHelperSessionScope(options?.appBundleId),
      });
      return read ?? undefined;
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
            helperSessionScope: androidHelperSessionScope(snapshotOptions.appBundleId),
          }),
        { backend: 'android' },
      );
      return androidSnapshotPublicationInput(result);
    },
    back: (_mode) => backAndroid(device),
    home: () => homeAndroid(device),
    setOrientation: (orientation) => setAndroidOrientation(device, orientation),
    appSwitcher: () => appSwitcherAndroid(device),
    tvRemote: (button, durationMs) => pressAndroidTvRemote(device, button, durationMs),
    keyboardStatus: async () => ({ kind: 'ime-probe', ...(await getAndroidKeyboardState(device)) }),
    keyboardDismiss: async () => ({ kind: 'ime-probe', ...(await dismissAndroidKeyboard(device)) }),
    keyboardEnter: async () => {
      await pressAndroidEnter(device);
      return { kind: 'android-acknowledged' };
    },
    readClipboard: () => readAndroidClipboardText(device),
    writeClipboard: (text) => writeAndroidClipboardText(device, text),
    setSetting: (setting, state, appId, options) =>
      setAndroidSetting(device, setting, state, appId, options),
    // R59: Android's alert legs read the same presented accessibility tree `snapshot` publishes
    // and own their own polling, so the family supplies the node capture rather than the daemon.
    // The presentation pass matters: alert candidacy skips occlusion-blocked nodes, and only a
    // presented tree carries that annotation.
    readAlert: async () => await handleAndroidAlert(device, 'get', alertOptions()),
    awaitAlert: async (options) =>
      await handleAndroidAlert(device, 'wait', alertOptions(options?.timeoutMs)),
    acceptAlert: async () => await handleAndroidAlert(device, 'accept', alertOptions()),
    dismissAlert: async () => await handleAndroidAlert(device, 'dismiss', alertOptions()),
  };
  if (!provider) return interactor;
  return withMethodScope(interactor, (task) =>
    withAndroidAdbProvider(provider, { serial: device.id }, task),
  );
}
