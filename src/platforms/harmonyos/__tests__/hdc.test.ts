import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

import { runCmd } from '@agent-device/host-kit/command';
import { DEFAULT_HARMONY_HDC_TIMEOUT_MS, runHarmonyHdc } from '../hdc.ts';

const mockRunCmd = vi.mocked(runCmd);
const device = { id: '127.0.0.1:5555' };

beforeEach(() => {
  mockRunCmd.mockReset();
  mockRunCmd.mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
});

test('runHarmonyHdc bounds ordinary HDC commands by a default timeout', async () => {
  await runHarmonyHdc(device, ['shell', 'uitest', 'uiInput', 'click', '10', '20']);

  assert.deepEqual(mockRunCmd.mock.calls[0], [
    'hdc',
    ['-t', '127.0.0.1:5555', 'shell', 'uitest', 'uiInput', 'click', '10', '20'],
    { timeoutMs: DEFAULT_HARMONY_HDC_TIMEOUT_MS },
  ]);
});

test('runHarmonyHdc preserves an operation-specific timeout', async () => {
  await runHarmonyHdc(device, ['install', '-r', '/tmp/example.hap'], { timeoutMs: 180_000 });

  assert.deepEqual(mockRunCmd.mock.calls[0]?.[2], { timeoutMs: 180_000 });
});

test('runHarmonyHdc forwards a binding abort signal to an in-flight HDC command', async () => {
  const controller = new AbortController();
  const aborted = new Error('request aborted');
  mockRunCmd.mockImplementation(
    async (_cmd, _args, options) =>
      await new Promise<never>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        });
      }),
  );

  const pending = runHarmonyHdc(device, ['install', '-r', '/tmp/example.hap'], {
    signal: controller.signal,
  });
  controller.abort(aborted);

  await assert.rejects(pending, (error: unknown) => error === aborted);
  assert.equal(mockRunCmd.mock.calls[0]?.[2]?.signal, controller.signal);
});
