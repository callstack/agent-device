import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { Interactor } from '@agent-device/contracts/interaction';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createVegaInteractor } from '../interactor.ts';
import { pressVegaTvRemote } from '../input-actions.ts';
import { closeVegaApp, openVegaApp, openVegaDevice } from '../app-lifecycle.ts';

vi.mock('../input-actions.ts', () => ({ pressVegaTvRemote: vi.fn() }));
vi.mock('../app-lifecycle.ts', () => ({
  closeVegaApp: vi.fn(),
  openVegaApp: vi.fn(),
  openVegaDevice: vi.fn(),
}));

const VEGA_VVD: DeviceInfo = {
  platform: 'vega',
  id: 'VirtualDevice',
  name: 'Vega Virtual Device',
  kind: 'emulator',
  target: 'tv',
  booted: true,
};

const mockPressVegaTvRemote = vi.mocked(pressVegaTvRemote);
const mockCloseVegaApp = vi.mocked(closeVegaApp);
const mockOpenVegaApp = vi.mocked(openVegaApp);
const mockOpenVegaDevice = vi.mocked(openVegaDevice);

beforeEach(() => {
  mockPressVegaTvRemote.mockReset();
  mockPressVegaTvRemote.mockResolvedValue(undefined);
  mockCloseVegaApp.mockReset();
  mockCloseVegaApp.mockResolvedValue(undefined);
  mockOpenVegaApp.mockReset();
  mockOpenVegaApp.mockResolvedValue(undefined);
  mockOpenVegaDevice.mockReset();
  mockOpenVegaDevice.mockResolvedValue(undefined);
});

test('tvRemote, back, and home share the Vega remote primitive', async () => {
  const interactor = createVegaInteractor(VEGA_VVD, {});

  await interactor.tvRemote('left', 250);
  await interactor.back('system');
  await interactor.home();

  assert.deepEqual(mockPressVegaTvRemote.mock.calls, [
    [VEGA_VVD, 'left', 250],
    [VEGA_VVD, 'back'],
    [VEGA_VVD, 'home'],
  ]);
});

test('open, openDevice, and close use the Vega app lifecycle', async () => {
  const interactor = createVegaInteractor(VEGA_VVD, {});

  await interactor.openDevice();
  await interactor.open('com.example.app.main');
  await interactor.close('com.example.app.main');

  assert.deepEqual(mockOpenVegaDevice.mock.calls, [[VEGA_VVD]]);
  assert.deepEqual(mockOpenVegaApp.mock.calls, [[VEGA_VVD, 'com.example.app.main']]);
  assert.deepEqual(mockCloseVegaApp.mock.calls, [[VEGA_VVD, 'com.example.app.main']]);
});

test('open rejects unsupported Vega launch variants instead of silently dropping them', async () => {
  const interactor = createVegaInteractor(VEGA_VVD, {});

  const variants: Array<{
    app: string;
    options?: Parameters<Interactor['open']>[1];
    message: string;
  }> = [
    {
      app: 'https://example.com/app',
      message: 'Vega open does not support URLs or deep links.',
    },
    {
      app: 'com.example.app.main',
      options: { url: 'https://example.com/app' },
      message: 'Vega open does not support URLs or deep links.',
    },
    {
      app: 'com.example.app.main',
      options: { activity: '.MainActivity' },
      message: 'Vega open does not support Android activity selection.',
    },
    {
      app: 'com.example.app.main',
      options: { launchConsole: '/tmp/vega.log' },
      message: 'Vega open does not support launch-console output.',
    },
    {
      app: 'com.example.app.main',
      options: { terminateRunningApp: true },
      message: 'Vega open does not support terminating the running app before launch.',
    },
    {
      app: 'com.example.app.main',
      options: { launchArgs: ['--debug'] },
      message: 'Vega open does not support launch arguments.',
    },
  ];

  for (const variant of variants) {
    await assert.rejects(
      interactor.open(variant.app, variant.options),
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_OPERATION' &&
        error.message === variant.message,
      variant.message,
    );
  }
  assert.equal(mockOpenVegaApp.mock.calls.length, 0);
});

test('required unproven Vega operations share typed unsupported behavior', async () => {
  const interactor = createVegaInteractor(VEGA_VVD, {});
  const unsupportedCalls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['tap', () => interactor.tap(10, 20)],
    ['doubleTap', () => interactor.doubleTap(10, 20)],
    ['longPress', () => interactor.longPress(10, 20, 500)],
    ['focus', () => interactor.focus(10, 20)],
    ['type', () => interactor.type('text')],
    ['fill', () => interactor.fill(10, 20, 'text')],
    ['scroll', () => interactor.scroll('down')],
    ['screenshot', () => interactor.screenshot('/tmp/vega.png')],
    ['snapshot', () => interactor.snapshot()],
    ['setOrientation', () => interactor.setOrientation('portrait')],
    ['appSwitcher', () => interactor.appSwitcher()],
    ['readClipboard', () => interactor.readClipboard()],
    ['writeClipboard', () => interactor.writeClipboard('text')],
    ['setSetting', () => interactor.setSetting('wifi', 'on')],
  ];

  for (const [operation, call] of unsupportedCalls) {
    await assert.rejects(
      call,
      (error: unknown) =>
        error instanceof AppError &&
        error.code === 'UNSUPPORTED_OPERATION' &&
        error.message === `${operation} is not supported on Vega OS`,
      operation,
    );
  }
  assert.equal(mockPressVegaTvRemote.mock.calls.length, 0);
});

test('optional Vega operations stay absent so shared dispatch keeps its fallback semantics', async () => {
  const interactor = createVegaInteractor(VEGA_VVD, {});
  const optionalOperations: Array<keyof Interactor> = [
    'tapElementSelector',
    'setViewport',
    'gestureViewport',
    'performGesture',
  ];

  for (const operation of optionalOperations) {
    assert.equal(interactor[operation], undefined, operation);
  }
  assert.equal(await interactor.gestureViewport?.(), undefined);
});
