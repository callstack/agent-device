import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { createLinuxInteractor } from './linux.ts';
import { middleClickLinux, pressLinux, rightClickLinux } from '@agent-device/platform-linux';

vi.mock('@agent-device/platform-linux', () => ({
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
  const interactor = createLinuxInteractor();

  await interactor.alternateClick!({ x: 10, y: 20 }, 'secondary');
  await interactor.alternateClick!({ x: 30, y: 40 }, 'middle');

  assert.deepEqual(vi.mocked(rightClickLinux).mock.calls, [[10, 20]]);
  assert.deepEqual(vi.mocked(middleClickLinux).mock.calls, [[30, 40]]);
  assert.equal(vi.mocked(pressLinux).mock.calls.length, 0);
});
