import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import type { GesturePlan } from '@agent-device/contracts/gesture-plan-types';
import type { Interactor, PressPointOptions } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createAppleInteractor } from '../interactor.ts';
import { resolveIosPhysicalDeviceControl } from '../core/physical-device-control.ts';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import { queryAppleRunnerSelector } from '../core/runner-selector-query.ts';
import { captureScreenshotViaRunner } from '../core/screenshot.ts';
import { withAppleRunnerProvider, type RunnerCommand } from '../runner/index.ts';
import {
  IOS_DEVICE,
  IOS_SIMULATOR,
  MACOS_DEVICE,
  TVOS_SIMULATOR,
} from '../runner/__tests__/device-fixtures.ts';
import { assertProducedRunnerRequests } from '../runner/runner-requests.fixtures.ts';
import {
  recordingRunnerProvider,
  singlePointerPanPlan,
  type RecordedRunnerCall,
} from './recording-runner-provider.ts';
import { mkdtempForTest } from './tmp-dir.ts';

// Every Apple runner request site outside `runner/`, driven through its production entry point and
// pinned to contracts/fixtures/runner-requests.json. The drives never write a request themselves;
// runner/__tests__/runner-requests.test.ts reads this source to keep it that way.

const APP = 'com.example.app';
const XCTEST_DEVICE: DeviceInfo = { ...IOS_DEVICE, iosPhysicalDeviceBackend: 'xctest' };

type InteractorDrive = readonly [DeviceInfo, (interactor: Interactor) => Promise<unknown>];

function press(overrides: Partial<PressPointOptions> = {}) {
  return (interactor: Interactor) =>
    interactor.pressPoint!(
      { x: 10, y: 20 },
      {
        button: 'primary',
        count: 1,
        intervalMs: 0,
        holdMs: 0,
        jitterPx: 0,
        doubleTap: false,
        ...overrides,
      },
    );
}

const INTERACTOR_SITES: Record<string, InteractorDrive> = {
  'ios-simulator.interactions-tap.synthesized': [IOS_SIMULATOR, (i) => i.tap(10, 20)],
  'macos.interactions-tap.coordinate': [MACOS_DEVICE, (i) => i.tap(10, 20)],
  'ios-simulator.interactions-focus.synthesized': [IOS_SIMULATOR, (i) => i.focus(10, 20)],
  'macos.interactions-focus.coordinate': [MACOS_DEVICE, (i) => i.focus(10, 20)],
  'ios-simulator.interactions-single-press-tap.synthesized': [IOS_SIMULATOR, press()],
  'macos.interactions-single-press-tap.coordinate': [MACOS_DEVICE, press()],
  'ios-simulator.interactions-tap-element-selector.expected-point': [
    IOS_SIMULATOR,
    (i) =>
      i.tapElementSelector!({
        key: 'label',
        value: 'Go',
        allowNonHittableCoordinateFallback: true,
        expectedPoint: { x: 10, y: 20 },
      }),
  ],
  'ios-simulator.interactions-double-tap.single': [IOS_SIMULATOR, (i) => i.doubleTap!(10, 20)],
  'ios-simulator.interactions-long-press.duration': [
    IOS_SIMULATOR,
    (i) => i.longPress(10, 20, 600),
  ],
  'ios-simulator.interactions-type.append': [IOS_SIMULATOR, (i) => i.type('hello', 10)],
  'ios-simulator.interactions-type.newline': [IOS_SIMULATOR, (i) => i.type('\n')],
  'ios-simulator.interactions-fill.replace': [IOS_SIMULATOR, (i) => i.fill(10, 20, 'hello', 10)],
  'ios-simulator.interactions-fill.non-hittable-fallback': [
    IOS_SIMULATOR,
    (i) => i.fill(10, 20, 'hello', undefined, { allowNonHittableCoordinateFallback: true }),
  ],
  'ios-simulator.interactions-gesture-viewport.read': [IOS_SIMULATOR, (i) => i.gestureViewport!()],
  'ios-simulator.interactions-press-series.tap': [
    IOS_SIMULATOR,
    press({ count: 2, intervalMs: 50 }),
  ],
  'ios-simulator.interactions-press-series.double-tap': [
    IOS_SIMULATOR,
    press({ count: 2, intervalMs: 50, doubleTap: true }),
  ],
  'ios-simulator.interactions-press-series.long-press': [
    IOS_SIMULATOR,
    press({ count: 2, intervalMs: 50, holdMs: 600 }),
  ],
  'macos.interactions-mouse-click.secondary': [MACOS_DEVICE, press({ button: 'secondary' })],
  'macos.interactions-mouse-click.middle': [MACOS_DEVICE, press({ button: 'middle' })],
  'ios-simulator.interactions-single-press-double-tap.single': [
    IOS_SIMULATOR,
    press({ doubleTap: true }),
  ],
  'ios-simulator.interactions-single-press-long-press.hold': [
    IOS_SIMULATOR,
    press({ holdMs: 600 }),
  ],
  'macos.interactions-drag.single': [
    MACOS_DEVICE,
    (i) => i.performGesture!(singlePointerPanPlan()),
  ],
  'tvos.interactions-swipe.single': [
    TVOS_SIMULATOR,
    (i) => i.performGesture!(singlePointerPanPlan()),
  ],
  'ios-simulator.interactions-gesture.single': [
    IOS_SIMULATOR,
    (i) => i.performGesture!(singlePointerPanPlan()),
  ],
  'ios-simulator.interactions-gesture.two': [IOS_SIMULATOR, (i) => i.performGesture!(pinchPlan())],
  'tvos.interactions-scroll.remote-press': [
    TVOS_SIMULATOR,
    (i) => i.scroll('down', { durationMs: 300 }),
  ],
  'ios-simulator.interactions-scroll.amount': [IOS_SIMULATOR, (i) => i.scroll('down')],
  'ios-simulator.interactions-scroll.pixels': [
    IOS_SIMULATOR,
    (i) => i.scroll('up', { pixels: 200, durationMs: 300 }),
  ],
  'ios-simulator.interactions-scroll.inertial': [
    IOS_SIMULATOR,
    (i) => i.scroll('left', { amount: 0.5, releaseBehavior: 'inertial' }),
  ],
  'macos.desktop-scroll.amount': [
    MACOS_DEVICE,
    (i) => i.scroll('down', { amount: 0.5, durationMs: 300 }),
  ],
  'macos.desktop-scroll.pixels': [
    MACOS_DEVICE,
    (i) => i.scroll('up', { pixels: 200, durationMs: 300 }),
  ],
  'ios-simulator.interactor-find-text.text': [
    IOS_SIMULATOR,
    (i) => i.findText!('Ready', { appBundleId: APP }),
  ],
  'tvos.interactor-back.remote-press': [TVOS_SIMULATOR, (i) => i.back()],
  'ios-simulator.interactor-back.in-app': [IOS_SIMULATOR, (i) => i.back()],
  'ios-simulator.interactor-back.system': [IOS_SIMULATOR, (i) => i.back('system')],
  'tvos.interactor-home.remote-press': [TVOS_SIMULATOR, (i) => i.home!()],
  'ios-simulator.interactor-home.press': [IOS_SIMULATOR, (i) => i.home!()],
  'ios-simulator.interactor-set-orientation.rotate': [
    IOS_SIMULATOR,
    (i) => i.setOrientation('landscape-left'),
  ],
  'ios-simulator.interactor-app-state.read': [IOS_SIMULATOR, (i) => i.appState!()],
  'ios-simulator.interactor-app-switcher.open': [IOS_SIMULATOR, (i) => i.appSwitcher!()],
  'ios-simulator.interactor-action-button.press': [IOS_SIMULATOR, (i) => i.actionButton!()],
  'tvos.interactor-tv-remote.hold': [TVOS_SIMULATOR, (i) => i.tvRemote!('select', 500)],
  'ios-simulator.interactor-keyboard-dismiss.dismiss': [IOS_SIMULATOR, (i) => i.keyboardDismiss!()],
  'ios-simulator.interactor-keyboard-enter.return': [IOS_SIMULATOR, (i) => i.keyboardEnter!()],
  'ios-simulator.interactor-snapshot.every-option': [
    IOS_SIMULATOR,
    (i) =>
      i.snapshot({
        appBundleId: APP,
        interactiveOnly: true,
        preferredBackend: 'tree',
        customActions: true,
        depth: 3,
        scope: 'Go',
        raw: true,
      }),
  ],
  'ios-simulator.interactor-read-text.point': [
    IOS_SIMULATOR,
    (i) => i.readTextAtPoint!({ x: 10, y: 20 }, { appBundleId: APP }),
  ],
  'ios-simulator.alert.get': [IOS_SIMULATOR, (i) => i.readAlert!({ appBundleId: APP })],
  'ios-simulator.alert.accept': [IOS_SIMULATOR, (i) => i.acceptAlert!({ appBundleId: APP })],
  'ios-simulator.alert.dismiss': [IOS_SIMULATOR, (i) => i.dismissAlert!({ appBundleId: APP })],
};

type ScopedDrive = readonly [DeviceInfo, (outPath: string) => Promise<unknown>];

const SCOPED_SITES: Record<string, ScopedDrive> = {
  'ios-simulator.runner-selector-query.label': [
    IOS_SIMULATOR,
    () => queryAppleRunnerSelector(IOS_SIMULATOR, { key: 'label', value: 'Go' }, APP, {}),
  ],
  'macos.screenshot-runner.fullscreen': [
    MACOS_DEVICE,
    (outPath) => captureScreenshotViaRunner(MACOS_DEVICE, outPath, APP, true),
  ],
  'ios-device.physical-device-screenshot.coredevice-file': [
    IOS_DEVICE,
    (outPath) => captureScreenshotViaRunner(IOS_DEVICE, outPath, APP, true),
  ],
  'ios-device.physical-device-screenshot.xctest-inline': [
    XCTEST_DEVICE,
    (outPath) => captureScreenshotViaRunner(XCTEST_DEVICE, outPath, APP),
  ],
  'ios-device.physical-device-control.activate': [
    XCTEST_DEVICE,
    () =>
      resolveIosPhysicalDeviceControl(XCTEST_DEVICE).launchApp(XCTEST_DEVICE, APP, {
        runRunnerCommand: runAppleRunnerCommand,
      }),
  ],
  'ios-device.physical-device-control.terminate': [
    XCTEST_DEVICE,
    () =>
      resolveIosPhysicalDeviceControl(XCTEST_DEVICE).terminateApp(XCTEST_DEVICE, APP, {
        runRunnerCommand: runAppleRunnerCommand,
      }),
  ],
};

test('every Apple request site builds exactly its golden runner request', async () => {
  const captured: Array<readonly [string, RunnerCommand]> = [];
  for (const [name, [device, drive]] of Object.entries(INTERACTOR_SITES)) {
    const calls: RecordedRunnerCall[] = [];
    await drive(
      createAppleInteractor(device, { appBundleId: APP }, recordingRunnerProvider(calls)),
    );
    captured.push([name, onlyRequest(name, calls)]);
  }
  const dir = await mkdtempForTest('agent-device-runner-requests-');
  const runnerScreenshot = path.join(dir, 'runner.png');
  fs.writeFileSync(runnerScreenshot, '');
  for (const [name, [device, drive]] of Object.entries(SCOPED_SITES)) {
    const calls: RecordedRunnerCall[] = [];
    const provider = recordingRunnerProvider(calls, {
      screenshot: { message: runnerScreenshot, imageBase64: 'AA==' },
    });
    await withAppleRunnerProvider(provider, { deviceId: device.id }, () =>
      drive(path.join(dir, `${name}.png`)),
    );
    captured.push([name, onlyRequest(name, calls)]);
  }
  assertProducedRunnerRequests(import.meta.filename, captured);
});

function onlyRequest(name: string, calls: RecordedRunnerCall[]): RunnerCommand {
  if (calls.length !== 1) throw new Error(`${name} sent ${calls.length} runner requests`);
  return calls[0]!.command;
}

function pinchPlan(): GesturePlan {
  return {
    topology: 'two',
    intent: 'pinch',
    durationMs: 250,
    viewport: { x: 0, y: 0, width: 390, height: 844 },
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 150, y: 422 } },
          { offsetMs: 250, point: { x: 100, y: 422 } },
        ],
      },
      {
        pointerId: 1,
        samples: [
          { offsetMs: 0, point: { x: 240, y: 422 } },
          { offsetMs: 250, point: { x: 290, y: 422 } },
        ],
      },
    ],
  };
}
