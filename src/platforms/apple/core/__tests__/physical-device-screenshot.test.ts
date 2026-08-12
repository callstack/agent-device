import { test } from 'vitest';
import assert from 'node:assert/strict';
import { IOS_DEVICE } from '../../../../__tests__/test-utils/index.ts';
import {
  captureCoreDeviceScreenshot,
  shouldFallbackToRunnerForIosScreenshot,
} from '../physical-device-screenshot.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { AppError } from '@agent-device/kernel/errors';

test('captureCoreDeviceScreenshot invokes devicectl with the current capture-screenshot syntax', async () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];

  await withAppleToolProvider(
    createLocalAppleToolProvider({
      runCommand: async (cmd, args) => {
        calls.push({ cmd, args });
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    }),
    async () =>
      await captureCoreDeviceScreenshot(IOS_DEVICE, '/tmp/out.png', {
        runRunnerCommand: async () => {
          throw new Error('devicectl capture should have succeeded without a runner fallback');
        },
      }),
  );

  assert.deepEqual(calls, [
    {
      cmd: 'xcrun',
      args: [
        'devicectl',
        'device',
        'capture',
        'screenshot',
        '--device',
        IOS_DEVICE.id,
        '--destination',
        '/tmp/out.png',
      ],
    },
  ]);
});

test('shouldFallbackToRunnerForIosScreenshot detects removed devicectl subcommand output', () => {
  const error = new AppError('COMMAND_FAILED', 'Failed to capture iOS screenshot', {
    stderr: "error: Unknown option '--device'",
  });
  assert.equal(shouldFallbackToRunnerForIosScreenshot(error), true);
});

test('shouldFallbackToRunnerForIosScreenshot ignores unrelated command failures', () => {
  const error = new AppError('COMMAND_FAILED', 'Failed to capture iOS screenshot', {
    stderr: 'error: device is busy connecting',
  });
  assert.equal(shouldFallbackToRunnerForIosScreenshot(error), false);
});
