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
import { isPlayableVideo, prepareVideoValidator, waitForPlayableVideo } from './video.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));
vi.mock('./swift-cache.ts', () => ({
  buildSwiftToolEnv: () => ({}),
  readCompiledSwiftSourceText: vi.fn(() => undefined),
  compileSwiftSourceText: vi.fn(async () => '/bin/true'),
}));

beforeEach(() => {
  vi.mocked(runCmd).mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  vi.mocked(compileSwiftSourceText).mockReset().mockResolvedValue('/bin/true');
});

const directory = mkdtempForTestSync('agent-device-video-webm-');
const playableWebm = likelyPlayableWebmContainer();

test('accepts a real WebM video track and complete media block without AVFoundation', async () => {
  await expect(
    isPlayableVideo(writeFixture('capture.webm', playableWebm), undefined),
  ).resolves.toBe(true);
});

test('does not infer WebM from bytes when the requested container is different', async () => {
  await expect(isPlayableVideo(writeFixture('capture.bin', playableWebm), undefined)).resolves.toBe(
    false,
  );
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

const validator = { executablePath: '/prepared/video-validator', env: {} };

test('validation reuses the prepared executable without compiling at completion', async () => {
  const mp4 = writeFixture('prepared.mp4', Buffer.concat([ftyp, moov]));
  const prepared = await prepareVideoValidator(createTestHost());
  await expect(isPlayableVideo(mp4, prepared)).resolves.toBe(true);
  await expect(isPlayableVideo(mp4, prepared)).resolves.toBe(true);
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runCmd).mock.calls.map(([executable]) => executable)).toEqual([
    '/bin/true',
    '/bin/true',
  ]);
});

test('completion during preparation fails with a typed outcome and does not wait or compile', async () => {
  const mp4 = writeFixture('pending.mp4', Buffer.concat([ftyp, moov]));
  let finish!: (path: string) => void;
  let entered!: () => void;
  const preparationStarted = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.mocked(compileSwiftSourceText).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        entered();
      }),
  );
  const preparing = prepareVideoValidator(createTestHost());
  await preparationStarted;
  await expect(
    isPlayableVideo(mp4, undefined, Deadline.fromTimeoutMs(5_000)),
  ).rejects.toMatchObject({
    details: { reason: 'video_validator_not_prepared', retriable: true },
  });
  expect(runCmd).not.toHaveBeenCalled();
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(1);
  finish('/prepared/validator');
  await expect(isPlayableVideo(mp4, await preparing)).resolves.toBe(true);
});

test.each([
  `xcrun: error: unable to find utility "swiftc", not a developer tool or in PATH`,
  `/tmp/video-validator.swift:2:8: error: no such module 'AVFoundation'`,
])(
  'classifies a real unavailable toolchain message without claiming playability: %s',
  async (stderr) => {
    vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(
      new AppError('COMMAND_FAILED', 'compile failed', { stderr }),
    );
    await expect(prepareVideoValidator(createTestHost())).rejects.toMatchObject({
      details: { reason: 'video_validator_unavailable', retriable: false },
    });
    expect(runCmd).not.toHaveBeenCalled();
  },
);

test('does not classify a different missing module as unavailable AVFoundation', async () => {
  const error = new AppError('COMMAND_FAILED', 'compile failed', {
    stderr: "error: no such module 'AVFoundationExtras'",
  });
  vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(error);
  await expect(prepareVideoValidator(createTestHost())).rejects.toBe(error);
});

test('an unavailable validator at execution never makes an MP4 playable', async () => {
  const mp4 = writeFixture('unavailable.mp4', Buffer.concat([ftyp, moov]));
  vi.mocked(runCmd).mockResolvedValueOnce({
    exitCode: 1,
    stdout: '',
    stderr: `error: no such module 'AVFoundation'`,
  });
  await expect(isPlayableVideo(mp4, validator)).rejects.toMatchObject({
    details: { reason: 'video_validator_unavailable' },
  });
});

test('a budget spent before the validator runs reads as not playable instead of a 1 ms run', async () => {
  const mp4 = writeFixture('spent-budget.mp4', Buffer.concat([ftyp, moov]));
  await isPlayableVideo(mp4, validator);
  vi.mocked(runCmd).mockClear();

  await expect(isPlayableVideo(mp4, validator, Deadline.fromTimeoutMs(0))).resolves.toBe(false);
  await expect(
    waitForPlayableVideo(mp4, { validator, pollMs: 0, deadline: Deadline.fromTimeoutMs(0) }),
  ).resolves.toBe(false);
  expect(runCmd).not.toHaveBeenCalled();
});

test('the prepared validator run stays inside the caller deadline', async () => {
  const mp4 = writeFixture('run-clamp.mp4', Buffer.concat([ftyp, moov]));

  await isPlayableVideo(mp4, validator, Deadline.fromTimeoutMs(5_000));
  await isPlayableVideo(mp4, validator);

  const [withDeadline, withoutDeadline] = vi
    .mocked(runCmd)
    .mock.calls.map(([, , options]) => options?.timeoutMs);
  expect(withDeadline).toBeGreaterThan(0);
  expect(withDeadline).toBeLessThanOrEqual(5_000);
  expect(withoutDeadline).toBe(10_000);
});

test('a validator run that times out reads as not playable, whatever bound stopped it', async () => {
  const mp4 = writeFixture('run-cut-short.mp4', Buffer.concat([ftyp, moov]));
  const timedOut = (timeoutMs: number) =>
    new AppError('COMMAND_FAILED', `validator timed out after ${timeoutMs}ms`, { timeoutMs });
  vi.mocked(runCmd).mockImplementation(async (_cmd, _args, options) => {
    throw timedOut(options!.timeoutMs!);
  });
  // A frozen clock keeps the 5 ms budget from passing before the validator runs.
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    await expect(isPlayableVideo(mp4, validator, Deadline.fromTimeoutMs(5))).resolves.toBe(false);
    await expect(isPlayableVideo(mp4, validator)).resolves.toBe(false);
    expect(vi.mocked(runCmd).mock.calls.map(([, , options]) => options?.timeoutMs)).toEqual([
      5, 10_000,
    ]);
  } finally {
    vi.useRealTimers();
    vi.mocked(runCmd).mockReset();
    vi.mocked(runCmd).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  }
});

test('waiting for a playable video checks it once per attempt', async () => {
  const mp4 = writeFixture('never-plays.mp4', Buffer.concat([ftyp, moov]));
  vi.mocked(runCmd).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
  try {
    await expect(waitForPlayableVideo(mp4, { validator, pollMs: 0, attempts: 2 })).resolves.toBe(
      false,
    );
    expect(runCmd).toHaveBeenCalledTimes(2);
  } finally {
    vi.mocked(runCmd).mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  }
});

test('reaches the semantic validator with an MP4 container whose last box runs past the file', async () => {
  const truncated = Buffer.concat([ftyp, moov]).subarray(0, ftyp.length + moov.length - 4);
  await expect(isPlayableVideo(writeFixture('truncated.mp4', truncated), validator)).resolves.toBe(
    true,
  );
  expect(runCmd).toHaveBeenCalledTimes(1);
});

test('refuses an MP4 container that never declares a movie header', async () => {
  const container = Buffer.concat([ftyp, mp4Atom('mdat', Buffer.alloc(8))]);
  await expect(isPlayableVideo(writeFixture('no-moov.mp4', container), undefined)).resolves.toBe(
    false,
  );
  expect(runCmd).not.toHaveBeenCalled();
});

test('waiting for a playable video stops polling once its deadline passes', async () => {
  const filePath = path.join(mkdtempForTestSync('agent-device-video-wait-'), 'never-playable.mp4');
  fs.writeFileSync(filePath, '');
  const started = Date.now();
  await waitForPlayableVideo(filePath, {
    validator,
    pollMs: 60_000,
    deadline: Deadline.fromTimeoutMs(0),
  });
  expect(Date.now() - started).toBeLessThan(1_000);
});
