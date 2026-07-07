import { beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';

vi.mock('../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: vi.fn() };
});

import { dispatchCommand } from '../dispatch.ts';
import { AppError } from '../../kernel/errors.ts';
import { runAppleRunnerCommand } from '../../platforms/apple/core/runner/runner-client.ts';
import {
  ANDROID_EMULATOR,
  ANDROID_TV_DEVICE,
  TVOS_SIMULATOR,
} from '../../__tests__/test-utils/device-fixtures.ts';
import { withMockedAdb } from '../../__tests__/test-utils/mocked-binaries.ts';

const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);

beforeEach(() => {
  vi.resetAllMocks();
  mockRunAppleRunnerCommand.mockResolvedValue({ message: 'remotePress' });
});

test('dispatch tv-remote sends Android TV D-pad keyevents', async () => {
  await withMockedAdb('agent-device-dispatch-tv-remote-', async (argsLogPath) => {
    const result = await dispatchCommand(ANDROID_TV_DEVICE, 'tv-remote', ['right']);

    assert.equal(result?.action, 'tv-remote');
    assert.equal(result?.button, 'right');
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.match(logged, /shell\ninput\nkeyevent\nKEYCODE_DPAD_RIGHT/);
  });
});

test('dispatch tv-remote maps Android duration to longpress keyevent', async () => {
  await withMockedAdb('agent-device-dispatch-tv-remote-longpress-', async (argsLogPath) => {
    const result = await dispatchCommand(ANDROID_TV_DEVICE, 'tv-remote', ['select'], undefined, {
      durationMs: 500,
    });

    assert.equal(result?.durationMs, 500);
    const logged = await fs.readFile(argsLogPath, 'utf8');
    assert.match(logged, /shell\ninput\nkeyevent\n--longpress\nKEYCODE_DPAD_CENTER/);
  });
});

test('dispatch tv-remote sends native tvOS remotePress command', async () => {
  const result = await dispatchCommand(TVOS_SIMULATOR, 'tv-remote', ['back'], undefined, {
    appBundleId: 'com.example.tv',
    durationMs: 250,
  });

  assert.equal(result?.button, 'back');
  assert.equal(mockRunAppleRunnerCommand.mock.calls.length, 1);
  assert.deepEqual(mockRunAppleRunnerCommand.mock.calls[0]?.[1], {
    command: 'remotePress',
    remoteButton: 'menu',
    appBundleId: 'com.example.tv',
    durationMs: 250,
  });
});

test('dispatch tv-remote rejects non-TV targets before platform input', async () => {
  await assert.rejects(
    () => dispatchCommand(ANDROID_EMULATOR, 'tv-remote', ['down']),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'UNSUPPORTED_OPERATION' &&
      /TV targets/.test(error.message),
  );
});
