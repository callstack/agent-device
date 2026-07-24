import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { GesturePlan } from '../../../contracts/gesture-plan-types.ts';
import { AppError } from '../../../kernel/errors.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { createVegaInteractor } from '../interactor.ts';
import { pressVegaTvRemote } from '../input-actions.ts';
import { closeVegaApp, openVegaApp, openVegaDevice } from '../app-lifecycle.ts';

vi.mock('../input-actions.ts', () => ({ pressVegaTvRemote: vi.fn() }));
vi.mock('../app-lifecycle.ts', () => ({
  closeVegaApp: vi.fn(),
  openVegaApp: vi.fn(),
  openVegaDevice: vi.fn(),
}));

const VEGA_TV: DeviceInfo = {
  platform: 'vega',
  id: 'vega-tv',
  name: 'Vega TV',
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
  const interactor = createVegaInteractor(VEGA_TV, {});

  await interactor.tvRemote('left', 250);
  await interactor.back('system');
  await interactor.home();

  assert.deepEqual(mockPressVegaTvRemote.mock.calls, [
    [VEGA_TV, 'left', 250],
    [VEGA_TV, 'back'],
    [VEGA_TV, 'home'],
  ]);
});

test('open, openDevice, and close use the Vega app lifecycle', async () => {
  const interactor = createVegaInteractor(VEGA_TV, {});

  await interactor.openDevice();
  await interactor.open('com.example.app.main');
  await interactor.close('com.example.app.main');

  assert.deepEqual(mockOpenVegaDevice.mock.calls, [[VEGA_TV]]);
  assert.deepEqual(mockOpenVegaApp.mock.calls, [[VEGA_TV, 'com.example.app.main']]);
  assert.deepEqual(mockCloseVegaApp.mock.calls, [[VEGA_TV, 'com.example.app.main']]);
});

test('open rejects unsupported Vega launch variants instead of silently dropping them', async () => {
  const interactor = createVegaInteractor(VEGA_TV, {});

  await assert.rejects(
    interactor.open('com.example.app.main', { launchArgs: ['--debug'] }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      error.message === 'Vega open currently supports installed app component IDs only.',
  );
  assert.equal(mockOpenVegaApp.mock.calls.length, 0);
});

test('every unproven Vega interactor operation throws typed UNSUPPORTED_OPERATION', async () => {
  const interactor = createVegaInteractor(VEGA_TV, {});
  const gesturePlan: GesturePlan = {
    topology: 'single',
    intent: 'pan',
    executionProfile: 'timed-pan',
    durationMs: 100,
    viewport: { x: 0, y: 0, width: 1920, height: 1080 },
    pointers: [
      {
        pointerId: 0,
        samples: [
          { offsetMs: 0, point: { x: 0, y: 0 } },
          { offsetMs: 100, point: { x: 100, y: 100 } },
        ],
      },
    ],
  };
  const unsupportedCalls: ReadonlyArray<readonly [string, () => Promise<unknown>]> = [
    ['tap', () => interactor.tap(10, 20)],
    [
      'tapElementSelector',
      () => interactor.tapElementSelector!({ key: 'text', value: 'Continue' }),
    ],
    ['doubleTap', () => interactor.doubleTap(10, 20)],
    ['longPress', () => interactor.longPress(10, 20, 500)],
    ['focus', () => interactor.focus(10, 20)],
    ['type', () => interactor.type('text')],
    [
      'fillElementSelector',
      () => interactor.fillElementSelector!({ key: 'text', value: 'Email' }, 'user@example.com'),
    ],
    ['fill', () => interactor.fill(10, 20, 'text')],
    ['scroll', () => interactor.scroll('down')],
    ['screenshot', () => interactor.screenshot('/tmp/vega.png')],
    ['setViewport', () => interactor.setViewport!(1920, 1080)],
    ['snapshot', () => interactor.snapshot()],
    ['gestureViewport', () => interactor.gestureViewport!()],
    ['setOrientation', () => interactor.setOrientation('portrait')],
    ['performGesture', () => interactor.performGesture!(gesturePlan)],
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
