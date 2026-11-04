import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createRequestCanceledError } from '@agent-device/kernel/errors';
import { runCmd } from '@agent-device/host-kit/command';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));
vi.mock(import('@agent-device/capture-kit/recording-video'), async (importOriginal) => ({
  ...(await importOriginal()),
  waitForStableFile: vi.fn(async () => {}),
}));

test('a validator cancellation retains the failed live-owner release as secondary evidence', async () => {
  const root = mkdtempForTestSync('finalizer-cleanup-cancel-');
  const claims = path.join(root, 'claims');
  const cache = path.join(root, 'cache');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(claims);
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
  const outputPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(outputPath, Buffer.from('0000000c6674797069736f6d000000086d6f6f76', 'hex'));
  const env = {
    ...process.env,
    AGENT_DEVICE_CLAIMS_DIR: claims,
    AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
  };
  const host = createTestHostEnvironment({ cwd: root, env });
  const prepared = { kind: 'avfoundation' as const, executablePath: '/prepared/validator', env };
  const validator = {
    prepare: async () => prepared,
    read: () => Promise.resolve(prepared),
    close: async () => {},
  };
  const finalizer = createScreenRecordingFinalizer(host, validator);
  const cancel = new AbortController();
  vi.mocked(runCmd)
    .mockImplementationOnce(async () => {
      cancel.abort();
      throw createRequestCanceledError();
    })
    .mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  const rename = fs.renameSync;
  let injected = false;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
    if (
      !injected &&
      cancel.signal.aborted &&
      typeof to === 'string' &&
      to.endsWith(`${path.sep}pending.json`)
    ) {
      injected = true;
      throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  }) as typeof fs.renameSync);
  const input = { outputPath, showTouches: false, gestureEvents: [], targetLabel: 'recording' };
  try {
    const error = await finalizer.complete(input, cancel.signal).catch((error: unknown) => error);
    expect(error).toMatchObject({
      details: {
        reason: 'request_canceled',
        cleanupFailures: [
          {
            reason: 'swift_attempt_release_failed',
            attemptId: expect.stringMatching(/^validator-/),
            code: 'ENOSPC',
          },
        ],
      },
    });
    const attemptId = (error as { details: { cleanupFailures: Array<{ attemptId: string }> } })
      .details.cleanupFailures[0]!.attemptId;
    expect(injected).toBe(true);
    spy.mockRestore();
    await finalizer.complete(input);
    await vi.waitFor(() =>
      expect(fs.lstatSync(path.join(cache, 'attempts', attemptId, 'data')).isFile()).toBe(true),
    );
    expect(fs.readdirSync(claims)).toEqual([]);
    expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
  } finally {
    spy.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
