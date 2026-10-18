import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { createLinuxInteractor } from './interactor.ts';
import { buildGesturePlan } from '@agent-device/contracts/gesture-plan';
import { middleClickLinux, pressLinux, rightClickLinux, swipeLinux } from './index.ts';

vi.mock('./index.ts', () => ({
  backLinux: vi.fn(),
  captureLinuxSurfaceSnapshot: vi.fn(),
  closeLinuxApp: vi.fn(),
  doubleClickLinux: vi.fn(),
  fillLinux: vi.fn(),
  focusLinux: vi.fn(),
  homeLinux: vi.fn(),
  longPressLinux: vi.fn(),
  middleClickLinux: vi.fn(),
  openLinuxApp: vi.fn(),
  pressLinux: vi.fn(),
  readLinuxClipboard: vi.fn(),
  readLinuxTextAtPoint: vi.fn(),
  rightClickLinux: vi.fn(),
  scrollLinux: vi.fn(),
  screenshotLinux: vi.fn(),
  swipeLinux: vi.fn(),
  typeLinux: vi.fn(),
  writeLinuxClipboard: vi.fn(),
}));

beforeEach(() => vi.clearAllMocks());

test('Linux owns alternate buttons while the runtime binder owns primary series', async () => {
  const interactor = createLinuxInteractor({ env: process.env, cwd: process.cwd() });

  await interactor.alternateClick!({ x: 10, y: 20 }, 'secondary');
  await interactor.alternateClick!({ x: 30, y: 40 }, 'middle');

  assert.deepEqual(vi.mocked(rightClickLinux).mock.calls, [[10, 20]]);
  assert.deepEqual(vi.mocked(middleClickLinux).mock.calls, [[30, 40]]);
  assert.equal(vi.mocked(pressLinux).mock.calls.length, 0);
});

test('Linux executes a planned fling as one drag with the resolved duration', async () => {
  const plan = buildGesturePlan(
    { intent: 'fling', from: { x: 10, y: 20 }, to: { x: 110, y: 20 } },
    { x: 0, y: 0, width: 200, height: 200 },
    'linux',
  );

  await createLinuxInteractor({ env: process.env, cwd: process.cwd() }).performGesture!(plan);

  assert.deepEqual(vi.mocked(swipeLinux).mock.calls, [[10, 20, 110, 20, 100]]);
});
