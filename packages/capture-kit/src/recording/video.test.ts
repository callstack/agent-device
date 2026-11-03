import fs from 'node:fs';
import { createTestHost } from '../host-environment.fixtures.ts';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { AppError } from '@agent-device/kernel/errors';
import { likelyPlayableWebmContainer } from '../__tests__/test-utils/video-fixtures.ts';
import { mkdtempForTestSync } from '../tmp-dir.fixtures.ts';
import { mp4Atom, mp4MovieHeader } from './mp4.fixtures.ts';
import { Deadline } from '@agent-device/host-kit/retry';
import { compileSwiftSourceText, readCompiledSwiftSourceText } from './swift-cache.ts';
import { createVideoValidatorPreparation, isPlayableVideo, waitForPlayableVideo } from './video.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
}));
vi.mock('./swift-cache.ts', () => ({
  buildSwiftToolEnv: () => ({}),
  getSwiftCacheRoot: (env: NodeJS.ProcessEnv) => env.AGENT_DEVICE_SWIFT_CACHE_DIR,
  readCompiledSwiftSourceText: vi.fn(() => undefined),
  compileSwiftSourceText: vi.fn(async () => '/bin/true'),
}));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;

beforeEach(() => {
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  vi.stubEnv('AGENT_DEVICE_SWIFT_CACHE_DIR', mkdtempForTestSync('agent-device-video-validator-'));
  vi.mocked(runCmd).mockReset().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' });
  vi.mocked(compileSwiftSourceText).mockReset().mockResolvedValue('/bin/true');
  vi.mocked(readCompiledSwiftSourceText).mockReset().mockReturnValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  Object.defineProperty(process, 'platform', originalPlatform);
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

const validator = {
  kind: 'avfoundation' as const,
  executablePath: '/prepared/video-validator',
  env: {},
};

test.each(['linux', 'win32'] as const)(
  '%s recording validation uses container authority without Swift preparation',
  async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    vi.mocked(compileSwiftSourceText).mockRejectedValue(new AppError('TOOL_MISSING', 'no xcrun'));
    const host = createTestHost();
    const preparation = createVideoValidatorPreparation(host);
    const prepared = await preparation.prepare();
    expect(prepared).toEqual({ kind: 'container' });
    expect(await preparation.read()).toBe(prepared);
    await expect(preparation.close()).resolves.toBeUndefined();
    const mp4 = writeFixture(`${platform}.mp4`, Buffer.concat([ftyp, moov]));
    await expect(isPlayableVideo(mp4, prepared)).resolves.toBe(true);
    await expect(
      isPlayableVideo(writeFixture(`${platform}-invalid.mp4`, Buffer.from('invalid')), prepared),
    ).resolves.toBe(false);
    await expect(isPlayableVideo(mp4, undefined)).rejects.toMatchObject({
      details: { reason: 'video_validator_not_prepared' },
    });
    expect(compileSwiftSourceText).not.toHaveBeenCalled();
    expect(readCompiledSwiftSourceText).not.toHaveBeenCalled();
    expect(runCmd).not.toHaveBeenCalled();
  },
);

test('semantic authority still runs when the current platform differs from its construction host', async () => {
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
  vi.mocked(runCmd).mockResolvedValueOnce({ exitCode: 1, stdout: '', stderr: '' });
  await expect(
    isPlayableVideo(writeFixture('semantic.mp4', Buffer.concat([ftyp, moov])), validator),
  ).resolves.toBe(false);
  expect(runCmd).toHaveBeenCalledOnce();
});

test('validation reuses the prepared executable without compiling at completion', async () => {
  const mp4 = writeFixture('prepared.mp4', Buffer.concat([ftyp, moov]));
  const preparation = createVideoValidatorPreparation(createTestHost());
  const prepared = await preparation.prepare();
  await expect(isPlayableVideo(mp4, prepared)).resolves.toBe(true);
  await expect(isPlayableVideo(mp4, prepared)).resolves.toBe(true);
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(1);
  expect(vi.mocked(runCmd).mock.calls.map(([executable]) => executable)).toEqual([
    '/bin/true',
    '/bin/true',
  ]);
});

test('a stop deadline leaves preparation running and a later stop uses the same compile', async () => {
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
  const preparation = createVideoValidatorPreparation(createTestHost());
  const preparing = preparation.prepare();
  await preparationStarted;
  await expect(isPlayableVideo(mp4, preparing, Deadline.fromTimeoutMs(5))).rejects.toMatchObject({
    details: { reason: 'video_validator_not_prepared', retriable: true },
  });
  expect(runCmd).not.toHaveBeenCalled();
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(1);
  expect(preparation.prepare()).toBe(preparing);
  finish('/prepared/validator');
  await expect(isPlayableVideo(mp4, preparing)).resolves.toBe(true);
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(1);
});

test('each runtime owner compiles for itself instead of sharing a module-global preparation', async () => {
  const host = createTestHost();
  const first = createVideoValidatorPreparation(host);
  const second = createVideoValidatorPreparation(createTestHost());
  const otherRoot = createVideoValidatorPreparation({
    ...host,
    env: {
      ...host.env,
      AGENT_DEVICE_SWIFT_CACHE_DIR: `${host.env.AGENT_DEVICE_SWIFT_CACHE_DIR}-other`,
    },
  });
  const [firstResult, secondResult, otherResult] = await Promise.all([
    first.prepare(),
    second.prepare(),
    otherRoot.prepare(),
  ]);
  // Each owner memoizes its own compile: two runtimes on one cache compile twice, because no
  // module-global map shares their work any more, and the Swift cache lock is what excludes them.
  expect(firstResult).toEqual(secondResult);
  expect(otherResult).toEqual(firstResult);
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(3);

  // Closing one owner stops that owner's compile only; the other owners' work is untouched.
  const startedSignals = vi
    .mocked(compileSwiftSourceText)
    .mock.calls.map(([params]) => params.signal);
  expect(startedSignals.every((signal) => signal !== undefined && !signal.aborted)).toBe(true);
  await first.close();
  expect(startedSignals[0]!.aborted).toBe(true);
  expect(startedSignals[1]!.aborted).toBe(false);
  expect(startedSignals[2]!.aborted).toBe(false);
});

/** Stands in for a real compile: reports its signal and settles only when its caller ends it. */
function pendingCompile(): Readonly<{
  signals: AbortSignal[];
  enter: Promise<void>;
  finish: (error: Error) => void;
}> {
  const signals: AbortSignal[] = [];
  let entered!: () => void;
  let settle!: (error: Error) => void;
  const enter = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const outcome = new Promise<string>((_resolve, reject) => {
    settle = reject;
  });
  vi.mocked(compileSwiftSourceText).mockImplementation((params) => {
    signals.push(params.signal!);
    entered();
    return outcome;
  });
  return { signals, enter, finish: settle };
}

test('closing the owner cancels the compile it started and awaits its settlement', async () => {
  const compile = pendingCompile();
  const preparation = createVideoValidatorPreparation(createTestHost());
  const preparing = preparation.prepare();
  await compile.enter;

  let closed = false;
  const closing = preparation.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(compile.signals[0]!.aborted).toBe(true);

  // The compile owns the temp output and the cache lock, so closing waits for it to unwind.
  compile.finish(new AppError('COMMAND_FAILED', 'swiftc was stopped', { reason: 'canceled' }));
  await expect(closing).resolves.toBeUndefined();
  await expect(preparing).rejects.toMatchObject({ details: { reason: 'canceled' } });
});

test('closing marks the owner closed synchronously and later preparation starts nothing', async () => {
  const compile = pendingCompile();
  const preparation = createVideoValidatorPreparation(createTestHost());
  void preparation.prepare();
  await compile.enter;

  const closing = preparation.close();
  await expect(preparation.prepare()).rejects.toMatchObject({
    details: { reason: 'video_validator_preparation_closed', retriable: false },
  });
  expect(compile.signals[0]!.aborted).toBe(true);

  compile.finish(new AppError('COMMAND_FAILED', 'swiftc was stopped'));
  await closing;
  vi.mocked(compileSwiftSourceText).mockClear();
  await expect(preparation.prepare()).rejects.toMatchObject({
    details: { reason: 'video_validator_preparation_closed' },
  });
  expect(compileSwiftSourceText).not.toHaveBeenCalled();
});

test('closing a preparation that never started resolves without touching the cache', async () => {
  const preparation = createVideoValidatorPreparation(createTestHost());

  await expect(preparation.close()).resolves.toBeUndefined();
  expect(compileSwiftSourceText).not.toHaveBeenCalled();
});

test('closing a settled preparation returns at once and keeps the published authority readable', async () => {
  const preparation = createVideoValidatorPreparation(createTestHost());
  const prepared = await preparation.prepare();
  vi.mocked(readCompiledSwiftSourceText).mockReturnValue('/prepared/validator');

  await expect(preparation.close()).resolves.toBeUndefined();
  await expect(preparation.read()).resolves.toMatchObject({
    executablePath: '/prepared/validator',
  });
  expect(compileSwiftSourceText).toHaveBeenCalledTimes(1);
  expect(prepared.kind).toBe('avfoundation');
});

test('one owner closing never cancels another runtime owner’s compile', async () => {
  const compile = pendingCompile();
  const closing = createVideoValidatorPreparation(createTestHost());
  const recording = createVideoValidatorPreparation(createTestHost());
  const preparing = recording.prepare();
  await compile.enter;
  expect(compile.signals).toHaveLength(1);

  await closing.close();
  expect(compile.signals[0]!.aborted).toBe(false);

  compile.finish(new Error('another owner kept compiling'));
  await expect(preparing).rejects.toThrow('another owner kept compiling');
});

const preparationFailures = [
  {
    name: 'a contended cache lock',
    failure: new AppError('COMMAND_FAILED', 'Swift cache lock was busy', {
      reason: 'process_lock_timeout',
    }),
    reason: 'process_lock_timeout',
  },
  {
    name: 'an unavailable toolchain',
    failure: new AppError('TOOL_MISSING', 'no swiftc'),
    reason: 'video_validator_unavailable',
  },
] as const;

test.each(preparationFailures)(
  'failed preparation can be retried after $name',
  async ({ failure, reason }) => {
    const preparation = createVideoValidatorPreparation(createTestHost());
    vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(failure);
    const failed = preparation.prepare();
    expect(preparation.prepare()).toBe(failed);
    await expect(failed).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { reason } });
    expect(preparation.read()).toBe(failed);
    const originalError = await failed.catch((error: unknown) => error);
    const mp4 = writeFixture('retried.mp4', Buffer.concat([ftyp, moov]));
    await expect(isPlayableVideo(mp4, preparation.read())).rejects.toBe(originalError);

    const retry = preparation.prepare();
    expect(retry).not.toBe(failed);
    await expect(retry).resolves.toMatchObject({ executablePath: '/bin/true' });
    expect(preparation.read()).toBe(retry);
    await expect(isPlayableVideo(mp4, retry)).resolves.toBe(true);
    expect(compileSwiftSourceText).toHaveBeenCalledTimes(2);
  },
);

test.each(preparationFailures)(
  'a cache-only stop observes an executable published after $name',
  async ({ failure, reason }) => {
    const preparation = createVideoValidatorPreparation(createTestHost());
    vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(failure);
    const failed = preparation.prepare();
    await expect(failed).rejects.toMatchObject({ details: { reason } });
    expect(preparation.read()).toBe(failed);

    vi.mocked(readCompiledSwiftSourceText).mockReturnValue('/published/video-validator');
    const recovered = preparation.read();
    await expect(recovered).resolves.toMatchObject({
      executablePath: '/published/video-validator',
    });
    const mp4 = writeFixture('published.mp4', Buffer.concat([ftyp, moov]));
    await expect(isPlayableVideo(mp4, recovered)).resolves.toBe(true);
    expect(runCmd).toHaveBeenCalledWith('/published/video-validator', [mp4], expect.anything());
    expect(compileSwiftSourceText).toHaveBeenCalledTimes(1);
  },
);

test('an MP4 stop without prior preparation or cache reports not-prepared without compiling', async () => {
  const preparation = createVideoValidatorPreparation(createTestHost());
  expect(preparation.read()).toBeUndefined();
  await expect(
    isPlayableVideo(
      writeFixture('never-prepared.mp4', Buffer.concat([ftyp, moov])),
      preparation.read(),
    ),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'video_validator_not_prepared', retriable: true },
  });
  expect(compileSwiftSourceText).not.toHaveBeenCalled();
  expect(runCmd).not.toHaveBeenCalled();
});

test('WebM validation ignores failed background MP4 preparation', async () => {
  vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(
    new AppError('TOOL_MISSING', 'no swiftc'),
  );
  const preparing = createVideoValidatorPreparation(createTestHost()).prepare();
  await expect(preparing).rejects.toMatchObject({
    details: { reason: 'video_validator_unavailable' },
  });
  await expect(
    isPlayableVideo(writeFixture('without-swift.webm', playableWebm), preparing),
  ).resolves.toBe(true);
  expect(runCmd).not.toHaveBeenCalled();
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
    await expect(createVideoValidatorPreparation(createTestHost()).prepare()).rejects.toMatchObject(
      {
        details: { reason: 'video_validator_unavailable', retriable: false },
      },
    );
    expect(runCmd).not.toHaveBeenCalled();
  },
);

test('does not classify a different missing module as unavailable AVFoundation', async () => {
  const error = new AppError('COMMAND_FAILED', 'compile failed', {
    stderr: "error: no such module 'AVFoundationExtras'",
  });
  vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(error);
  await expect(createVideoValidatorPreparation(createTestHost()).prepare()).rejects.toBe(error);
});

test('an unavailable validator at execution never makes an MP4 playable', async () => {
  const mp4 = writeFixture('unavailable.mp4', Buffer.concat([ftyp, moov]));
  vi.mocked(runCmd).mockResolvedValueOnce({
    exitCode: 1,
    stdout: '',
    stderr: `error: no such module 'AVFoundation'`,
  });
  await expect(isPlayableVideo(mp4, validator)).rejects.toMatchObject({
    details: {
      reason: 'video_validator_unavailable',
      exitCode: 1,
      stdout: '',
      stderr: `error: no such module 'AVFoundation'`,
    },
    cause: {
      details: { stderr: `error: no such module 'AVFoundation'` },
    },
  });
});

test('a removed prepared executable returns the typed unavailable outcome', async () => {
  vi.mocked(runCmd).mockRejectedValueOnce(new AppError('TOOL_MISSING', 'validator disappeared'));
  await expect(
    isPlayableVideo(writeFixture('removed.mp4', Buffer.concat([ftyp, moov])), validator),
  ).rejects.toMatchObject({ details: { reason: 'video_validator_unavailable' } });
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

test('close reports a typed Swift cache cleanup failure', async () => {
  const failure = new AppError('COMMAND_FAILED', 'cleanup failed', {
    reason: 'swift_cache_cleanup_failed',
  });
  vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(failure);
  const preparation = createVideoValidatorPreparation(createTestHost());
  await expect(preparation.prepare()).rejects.toBe(failure);
  await expect(preparation.close()).rejects.toBe(failure);
});

test('a retry does not erase an earlier cleanup failure from close', async () => {
  const failure = new AppError('COMMAND_FAILED', 'cleanup failed', {
    reason: 'swift_cache_cleanup_failed',
  });
  vi.mocked(compileSwiftSourceText).mockRejectedValueOnce(failure);
  const preparation = createVideoValidatorPreparation(createTestHost());
  await expect(preparation.prepare()).rejects.toBe(failure);
  await expect(preparation.prepare()).resolves.toMatchObject({ kind: 'avfoundation' });
  await expect(preparation.close()).rejects.toBe(failure);
});
