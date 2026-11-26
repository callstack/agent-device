import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { runAppleRunnerCommand } from '../runner-client.ts';
import { captureScreenshotViaRunner } from '../screenshot.ts';
import { resolveAppleToolProvider, withAppleToolProvider } from '../tool-provider.ts';
import { IOS_TEST_SIMULATOR } from './apple-core-stub-helpers.ts';

vi.mock('../runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../runner-client.ts')>();
  return { ...actual, runAppleRunnerCommand: vi.fn() };
});

test('runner screenshot copy preserves an actionable endpoint refusal', async () => {
  vi.mocked(runAppleRunnerCommand).mockResolvedValue({ message: '/remote/tmp/runner.png' });
  const refusal = new AppError('COMMAND_FAILED', 'Refused authenticated download endpoint', {
    reason: 'limrun_download_endpoint_blocked',
    hint: 'Use an HTTPS instance URL and download from that same origin.',
  });
  const provider = resolveAppleToolProvider();
  const copyToHost = vi
    .fn()
    .mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'Container file is missing', { statusCode: 404 }),
    )
    .mockRejectedValue(refusal);
  await withAppleToolProvider(
    { ...provider, simulatorFiles: { ...provider.simulatorFiles, copyToHost } },
    async () => {
      await assert.rejects(
        captureScreenshotViaRunner(
          IOS_TEST_SIMULATOR,
          '/tmp/runner.png',
          undefined,
          undefined,
          undefined,
          {},
        ),
        (error: unknown) => error === refusal,
      );
    },
  );
  assert.equal(copyToHost.mock.calls.length, 2);
});
