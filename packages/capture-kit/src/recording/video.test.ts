import fs from 'node:fs';
import { createTestHost } from '../host-environment.fixtures.ts';
import path from 'node:path';
import { beforeEach, expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { likelyPlayableWebmContainer } from '../__tests__/test-utils/video-fixtures.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { mp4Atom, mp4MovieHeader } from './mp4.fixtures.ts';
import { Deadline } from '@agent-device/host-kit/retry';
import { compileSwiftSourceText } from './swift-cache.ts';
import { hasVideoContainer, isPlayableVideo, waitForPlayableVideo } from './video.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));
vi.mock('./swift-cache.ts', () => ({
  buildSwiftToolEnv: () => ({}),
  getSwiftCacheRoot: (env: NodeJS.ProcessEnv) => env.AGENT_DEVICE_SWIFT_CACHE_DIR ?? '',
  compileSwiftSourceText: vi.fn(async () => '/bin/true'),
}));

beforeEach(() => {
  vi.mocked(runCmd).mockClear();
});

const directory = mkdtempForTestSync('agent-device-video-webm-');
const playableWebm = likelyPlayableWebmContainer();

test('accepts a real WebM video track and complete media block without AVFoundation', async () => {
  await expect(
    isPlayableVideo(writeFixture('capture.webm', playableWebm), createTestHost()),
  ).resolves.toBe(true);
});

test('does not infer WebM from bytes when the requested container is different', async () => {
  await expect(
    isPlayableVideo(writeFixture('capture.bin', playableWebm), createTestHost()),
  ).resolves.toBe(false);
});

function writeFixture(name: string, bytes: Buffer): string {
  const filePath = path.join(directory, name);
  fs.writeFileSync(filePath, bytes);
  return filePath;
}

const ftyp = mp4Atom('ftyp', Buffer.from('isom', 'latin1'));
const moov = mp4Atom(
  'moov',
  mp4Atom('mvhd', mp4MovieHeader({ version: 0, timescale: 1_000, duration: 2_000 })),
);

test('each Swift cache root compiles its own validator, and a root reuses the one it has', async () => {
  const mp4 = writeFixture('validated.mp4', Buffer.concat([ftyp, moov]));
  const hostIn = (cacheDir: string) => ({
    env: { AGENT_DEVICE_SWIFT_CACHE_DIR: cacheDir },
    cwd: directory,
  });
  vi.mocked(compileSwiftSourceText).mockClear();

  await isPlayableVideo(mp4, hostIn('/cache/one'));
  await isPlayableVideo(mp4, hostIn('/cache/one'));
  await isPlayableVideo(mp4, hostIn('/cache/two'));

  expect(
    vi
      .mocked(compileSwiftSourceText)
      .mock.calls.map(([params]) => params.host.env.AGENT_DEVICE_SWIFT_CACHE_DIR),
  ).toEqual(['/cache/one', '/cache/two']);
});

test('callers share one validator compile, and each waits for it within its own budget', async () => {
  // A cold compile on a loaded CI runner outlasted a fixed 30 s wait while record stop had most of
  // its 70 s finalization budget left. A caller without a deadline that starts the compile first must
  // not impose its 30 s wait on a concurrent caller that has a deadline.
  const mp4 = writeFixture('shared-compile.mp4', Buffer.concat([ftyp, moov]));
  const host = { env: { AGENT_DEVICE_SWIFT_CACHE_DIR: '/cache/shared' }, cwd: directory };
  await hasVideoContainer(mp4);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    vi.mocked(compileSwiftSourceText)
      .mockClear()
      .mockImplementationOnce(
        () => new Promise((resolve) => setTimeout(() => resolve('/bin/true'), 45_000)),
      );

    const withoutDeadline = isPlayableVideo(mp4, host);
    const withDeadline = isPlayableVideo(mp4, host, Deadline.fromTimeoutMs(70_000));
    const withoutDeadlineRejected = expect(withoutDeadline).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      details: {
        reason: 'video_validator_compile_timeout',
        timeoutMs: 30_000,
        retriable: true,
        hint: expect.stringContaining('Run record stop again'),
      },
    });
    await vi.advanceTimersByTimeAsync(45_000);

    await withoutDeadlineRejected;
    await expect(withDeadline).resolves.toBe(true);
    expect(compileSwiftSourceText).toHaveBeenCalledOnce();
    const [compile] = vi.mocked(compileSwiftSourceText).mock.calls[0]!;
    expect(compile.timeoutMs).toBeUndefined();
    expect(compile.signal?.aborted).toBe(false);
  } finally {
    vi.useRealTimers();
  }
});

test('the last caller to stop waiting cancels an unfinished compile, and the next caller compiles again', async () => {
  // Nothing owns swiftc once its requests end: a daemon that exits while it runs leaves it
  // reparented to launchd, and the compile's own temp output behind.
  const mp4 = writeFixture('cancel-compile.mp4', Buffer.concat([ftyp, moov]));
  const host = { env: { AGENT_DEVICE_SWIFT_CACHE_DIR: '/cache/cancel' }, cwd: directory };
  await hasVideoContainer(mp4);
  let compileSignal: AbortSignal | undefined;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  try {
    vi.mocked(compileSwiftSourceText)
      .mockClear()
      .mockImplementationOnce(async ({ signal }) => {
        compileSignal = signal;
        return await new Promise<string>((_, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason));
        });
      });

    const timedOut = expect(
      isPlayableVideo(mp4, host, Deadline.fromTimeoutMs(5_000)),
    ).rejects.toMatchObject({ details: { reason: 'video_validator_compile_timeout' } });
    await vi.advanceTimersByTimeAsync(5_000);
    await timedOut;
    expect(compileSignal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }

  await expect(isPlayableVideo(mp4, host)).resolves.toBe(true);
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(2);
});

test('a failed compile is dropped, and the next caller compiles again', async () => {
  const mp4 = writeFixture('failed-compile.mp4', Buffer.concat([ftyp, moov]));
  const host = { env: { AGENT_DEVICE_SWIFT_CACHE_DIR: '/cache/failed' }, cwd: directory };
  vi.mocked(compileSwiftSourceText)
    .mockClear()
    .mockRejectedValueOnce(new AppError('COMMAND_FAILED', 'xcrun timed out after 120000ms'));

  await expect(isPlayableVideo(mp4, host)).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  await expect(isPlayableVideo(mp4, host)).resolves.toBe(true);
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(2);
});

test('a budget spent before the validator runs reads as not playable instead of a 1 ms run', async () => {
  const mp4 = writeFixture('spent-budget.mp4', Buffer.concat([ftyp, moov]));
  const host = { env: { AGENT_DEVICE_SWIFT_CACHE_DIR: '/cache/spent' }, cwd: directory };
  await isPlayableVideo(mp4, host);
  vi.mocked(runCmd).mockClear();

  await expect(isPlayableVideo(mp4, host, Deadline.fromTimeoutMs(0))).resolves.toBe(false);
  await expect(
    waitForPlayableVideo(mp4, { host, pollMs: 0, deadline: Deadline.fromTimeoutMs(0) }),
  ).resolves.toBe(false);
  expect(runCmd).not.toHaveBeenCalled();
});

test('the validator run after a compile stays inside the caller deadline', async () => {
  const mp4 = writeFixture('run-clamp.mp4', Buffer.concat([ftyp, moov]));
  const host = { env: { AGENT_DEVICE_SWIFT_CACHE_DIR: '/cache/run-clamp' }, cwd: directory };

  await isPlayableVideo(mp4, host, Deadline.fromTimeoutMs(5_000));
  await isPlayableVideo(mp4, host);

  const [withDeadline, withoutDeadline] = vi
    .mocked(runCmd)
    .mock.calls.map(([, , options]) => options?.timeoutMs);
  expect(withDeadline).toBeGreaterThan(0);
  expect(withDeadline).toBeLessThanOrEqual(5_000);
  expect(withoutDeadline).toBe(10_000);
});

test('a validator run the caller deadline cuts short reads as not playable', async () => {
  const mp4 = writeFixture('run-cut-short.mp4', Buffer.concat([ftyp, moov]));
  const host = { env: { AGENT_DEVICE_SWIFT_CACHE_DIR: '/cache/run-cut-short' }, cwd: directory };
  const timedOut = (timeoutMs: number) =>
    new AppError('COMMAND_FAILED', `validator timed out after ${timeoutMs}ms`, { timeoutMs });
  vi.mocked(runCmd).mockImplementation(async (_cmd, _args, options) => {
    throw timedOut(options!.timeoutMs!);
  });
  try {
    await expect(isPlayableVideo(mp4, host, Deadline.fromTimeoutMs(5))).resolves.toBe(false);
    // Without a deadline, the validator's own bound is a failure to report, not a verdict.
    await expect(isPlayableVideo(mp4, host)).rejects.toMatchObject({
      details: { timeoutMs: 10_000 },
    });
  } finally {
    vi.mocked(runCmd).mockReset();
    vi.mocked(runCmd).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  }
});

test('waiting for a playable video checks it once per attempt', async () => {
  const mp4 = writeFixture('never-plays.mp4', Buffer.concat([ftyp, moov]));
  vi.mocked(runCmd).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
  try {
    await expect(
      waitForPlayableVideo(mp4, { host: createTestHost(), pollMs: 0, attempts: 2 }),
    ).resolves.toBe(false);
    expect(runCmd).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(runCmd).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  }
});

test('reaches the semantic validator with an MP4 container whose last box runs past the file', async () => {
  const truncated = Buffer.concat([ftyp, moov]).subarray(0, ftyp.length + moov.length - 4);
  await expect(
    isPlayableVideo(writeFixture('truncated.mp4', truncated), createTestHost()),
  ).resolves.toBe(true);
  expect(runCmd).toHaveBeenCalledTimes(1);
});

test('refuses an MP4 container that never declares a movie header', async () => {
  const container = Buffer.concat([ftyp, mp4Atom('mdat', Buffer.alloc(8))]);
  await expect(
    isPlayableVideo(writeFixture('no-moov.mp4', container), createTestHost()),
  ).resolves.toBe(false);
  expect(runCmd).not.toHaveBeenCalled();
});

test('waiting for a playable video stops polling once its deadline passes', async () => {
  const filePath = path.join(mkdtempForTestSync('agent-device-video-wait-'), 'never-playable.mp4');
  fs.writeFileSync(filePath, '');
  const started = Date.now();
  await waitForPlayableVideo(filePath, {
    host: createTestHost(),
    pollMs: 60_000,
    deadline: Deadline.fromTimeoutMs(0),
  });
  expect(Date.now() - started).toBeLessThan(1_000);
});
