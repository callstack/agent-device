import { beforeEach, expect, test, vi } from 'vitest';

const { runCmdDetached } = vi.hoisted(() => ({ runCmdDetached: vi.fn(() => 4242) }));
vi.mock('@agent-device/host-kit/command', () => ({ runCmdDetached }));

import { createAndroidEmulatorHost } from './platform-runtime-android-emulator-host.ts';

beforeEach(() => {
  runCmdDetached.mockClear();
});

test('a windowed macOS launch hands focus back from the emulator process', () => {
  expect(createAndroidEmulatorHost('darwin').launch('Pixel_9', false)).toBe(4242);

  expect(runCmdDetached).toHaveBeenCalledTimes(2);
  expect(runCmdDetached).toHaveBeenNthCalledWith(1, 'emulator', ['-avd', 'Pixel_9']);
  expect(runCmdDetached).toHaveBeenNthCalledWith(2, 'osascript', [
    '-l',
    'JavaScript',
    '-e',
    expect.stringContaining('activateWithOptions'),
    '4242',
    '30000',
  ]);
});

test('a headless launch has no window to keep in the background', () => {
  createAndroidEmulatorHost('darwin').launch('Pixel_9', true);

  expect(runCmdDetached).toHaveBeenCalledOnce();
  expect(runCmdDetached).toHaveBeenCalledWith('emulator', [
    '-avd',
    'Pixel_9',
    '-no-window',
    '-no-audio',
  ]);
});

test('a launch on another host leaves window focus alone', () => {
  createAndroidEmulatorHost('linux').launch('Pixel_9', false);

  expect(runCmdDetached).toHaveBeenCalledOnce();
});
