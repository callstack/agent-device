import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';
import { waitForPlayableVideo } from '@agent-device/capture-kit/recording-video';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async (command: string, args: readonly string[]) => {
    const compiling = command === 'xcrun';
    const output = args[args.indexOf(compiling ? '-o' : '--output') + 1]!;
    fs.writeFileSync(output, compiling ? Buffer.alloc(1024 * 1024, 0x42) : 'processed', {
      mode: 0o755,
    });
    return { exitCode: 0, stdout: '', stderr: '' };
  }),
}));
vi.mock(import('@agent-device/capture-kit/recording-video'), async (importOriginal) => ({
  ...(await importOriginal()),
  waitForStableFile: vi.fn(async () => {}),
  waitForPlayableVideo: vi.fn(async () => true),
}));
test('a stalled overlay input copy returns a warning after the owned stream closes', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const root = mkdtempForTestSync('finalizer-copy-deadline-');
  const claims = path.join(root, 'claims');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(claims);
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'sentinel'), 'unchanged');
  const outputPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(outputPath, 'raw');
  const host = createTestHostEnvironment({
    cwd: root,
    env: {
      ...process.env,
      AGENT_DEVICE_CLAIMS_DIR: claims,
      AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
    },
  });
  const validator = {
    prepare: async () => ({ kind: 'container' as const }),
    read: () => Promise.resolve({ kind: 'container' as const }),
    close: async () => {},
  };
  let destroyed = false;
  let notifyRead!: () => void;
  const entered = new Promise<void>((resolve) => {
    notifyRead = resolve;
  });
  const actual = fs.createReadStream;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((source, options) => {
    if (source !== outputPath) return actual(source, options);
    return new Readable({
      read() {
        notifyRead();
      },
      destroy(error, callback) {
        destroyed = true;
        callback(error);
      },
    }) as fs.ReadStream;
  }) as typeof fs.createReadStream);
  try {
    const completion = createScreenRecordingFinalizer(host, validator).complete({
      outputPath,
      showTouches: true,
      gestureEvents: [{ kind: 'tap', tMs: 0, x: 1, y: 1 }],
      targetLabel: 'recording',
    });
    const first = await Promise.race([
      entered.then(() => 'entered'),
      completion.then(() => 'completed'),
    ]);
    expect(first).toBe('entered');
    const started = performance.now();
    await vi.advanceTimersByTimeAsync(70_000);
    const result = await completion;
    expect(performance.now() - started).toBeLessThan(1000);
    expect(destroyed).toBe(true);
    expect(result.overlayWarning).toContain('failed to overlay');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('raw');
    expect(fs.readdirSync(claims)).toEqual([]);
    expect(fs.readFileSync(path.join(sentinel, 'sentinel'), 'utf8')).toBe('unchanged');
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a validator that succeeds after the clock expires cannot publish over the raw recording', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const root = mkdtempForTestSync('finalizer-late-validation-');
  const claims = path.join(root, 'claims');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(claims);
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
  const outputPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(outputPath, 'raw');
  const host = createTestHostEnvironment({
    cwd: root,
    env: {
      ...process.env,
      AGENT_DEVICE_CLAIMS_DIR: claims,
      AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
    },
  });
  const validator = {
    prepare: async () => ({ kind: 'container' as const }),
    read: () => Promise.resolve({ kind: 'container' as const }),
    close: async () => {},
  };
  vi.mocked(waitForPlayableVideo)
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 70_001);
      return true;
    });
  try {
    const result = await createScreenRecordingFinalizer(host, validator).complete({
      outputPath,
      showTouches: true,
      gestureEvents: [{ kind: 'tap', tMs: 0, x: 1, y: 1 }],
      targetLabel: 'recording',
    });
    expect(result.overlayWarning).toContain('failed to overlay');
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('raw');
    expect(fs.readdirSync(claims)).toEqual([]);
    expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
  } finally {
    vi.useRealTimers();
    vi.mocked(waitForPlayableVideo).mockReset().mockResolvedValue(true);
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('overlay cancellation retains a failed release through the finalizer and retries on later use', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const root = mkdtempForTestSync('finalizer-overlay-cleanup-cancel-');
  const claims = path.join(root, 'claims');
  const cache = path.join(root, 'cache');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(claims);
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
  const outputPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(outputPath, 'raw');
  const host = createTestHostEnvironment({
    cwd: root,
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claims, AGENT_DEVICE_SWIFT_CACHE_DIR: cache },
  });
  const validator = {
    prepare: async () => ({ kind: 'container' as const }),
    read: () => Promise.resolve({ kind: 'container' as const }),
    close: async () => {},
  };
  const controller = new AbortController();
  vi.mocked(waitForPlayableVideo)
    .mockResolvedValueOnce(true)
    .mockImplementationOnce(async () => {
      controller.abort();
      return true;
    });
  const rename = fs.renameSync;
  let injected = false;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
    if (
      !injected &&
      controller.signal.aborted &&
      typeof to === 'string' &&
      to.endsWith(`${path.sep}pending.json`)
    ) {
      injected = true;
      throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
    }
    return rename(from, to);
  }) as typeof fs.renameSync);
  const input = {
    outputPath,
    showTouches: true,
    gestureEvents: [{ kind: 'tap' as const, tMs: 0, x: 1, y: 1 }],
    targetLabel: 'recording',
  };
  const finalizer = createScreenRecordingFinalizer(host, validator);
  try {
    const error = await finalizer
      .complete(input, controller.signal)
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      details: {
        reason: 'request_canceled',
        cleanupFailures: [
          {
            reason: 'swift_attempt_release_failed',
            attemptId: expect.stringMatching(/^overlay-/),
            code: 'ENOSPC',
          },
        ],
      },
    });
    const attemptId = (error as { details: { cleanupFailures: Array<{ attemptId: string }> } })
      .details.cleanupFailures[0]!.attemptId;
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('raw');
    spy.mockRestore();
    vi.mocked(waitForPlayableVideo).mockReset().mockResolvedValue(true);
    await finalizer.complete(input);
    await vi.waitFor(() =>
      expect(fs.lstatSync(path.join(cache, 'attempts', attemptId, 'data')).isFile()).toBe(true),
    );
    expect(fs.readdirSync(claims)).toEqual([]);
    expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
  } finally {
    spy.mockRestore();
    vi.mocked(waitForPlayableVideo).mockReset().mockResolvedValue(true);
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a cold compiler snapshot stalled after a chunk settles at the finalizer deadline', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const root = mkdtempForTestSync('finalizer-compiler-deadline-');
  const claims = path.join(root, 'claims');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(claims);
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
  const outputPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(outputPath, 'raw');
  const host = createTestHostEnvironment({
    cwd: root,
    env: {
      ...process.env,
      AGENT_DEVICE_CLAIMS_DIR: claims,
      AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
    },
  });
  const validator = {
    prepare: async () => ({ kind: 'container' as const }),
    read: () => Promise.resolve({ kind: 'container' as const }),
    close: async () => {},
  };
  let entered!: () => void;
  const stalled = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let stream: fs.ReadStream | undefined;
  let copied = 0;
  const read = fs.createReadStream;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((source, options) => {
    const created = read(source, options);
    if (
      typeof source === 'string' &&
      source.includes(`${path.sep}compiler-`) &&
      source.includes(`${path.sep}alias${path.sep}work${path.sep}`)
    ) {
      stream = created;
      const read = created._read;
      let reads = 0;
      created._read = function (size) {
        if (reads++ === 0) read.call(this, size);
        else entered();
      };
      created.on('data', (chunk) => {
        copied += chunk.length;
      });
    }
    return created;
  }) as typeof fs.createReadStream);
  try {
    const completion = createScreenRecordingFinalizer(host, validator).complete({
      outputPath,
      showTouches: true,
      gestureEvents: [{ kind: 'tap', tMs: 0, x: 1, y: 1 }],
      targetLabel: 'recording',
    });
    expect(
      await Promise.race([stalled.then(() => 'stalled'), completion.then(() => 'completed')]),
    ).toBe('stalled');
    const start = performance.now();
    await vi.advanceTimersByTimeAsync(70_000);
    const result = await completion;
    expect(performance.now() - start).toBeLessThan(1000);
    expect(copied).toBeGreaterThanOrEqual(64 * 1024);
    expect(stream?.destroyed).toBe(true);
    expect(stream?.closed).toBe(true);
    expect(result.overlayWarning).toContain('failed to overlay');
    expect(fs.readdirSync(path.join(root, 'cache', 'bin'))).toEqual([]);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('raw');
    expect(fs.readdirSync(claims)).toEqual([]);
    expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a compiler snapshot finishing after the clock expires is not published while the timer is delayed', async () => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const root = mkdtempForTestSync('finalizer-late-snapshot-');
  const claims = path.join(root, 'claims');
  const sentinel = path.join(root, 'sentinel');
  fs.mkdirSync(claims);
  fs.mkdirSync(sentinel);
  fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
  const outputPath = path.join(root, 'recording.mp4');
  fs.writeFileSync(outputPath, 'raw');
  const host = createTestHostEnvironment({
    cwd: root,
    env: {
      ...process.env,
      AGENT_DEVICE_CLAIMS_DIR: claims,
      AGENT_DEVICE_SWIFT_CACHE_DIR: path.join(root, 'cache'),
    },
  });
  const validator = {
    prepare: async () => ({ kind: 'container' as const }),
    read: () => Promise.resolve({ kind: 'container' as const }),
    close: async () => {},
  };
  let advanced = false;
  const read = fs.createReadStream;
  const spy = vi.spyOn(fs, 'createReadStream').mockImplementation(((source, options) => {
    const created = read(source, options);
    if (
      typeof source === 'string' &&
      source.includes(`${path.sep}compiler-`) &&
      source.includes(`${path.sep}alias${path.sep}work${path.sep}`)
    ) {
      created.once('end', () => {
        advanced = true;
        vi.setSystemTime(Date.now() + 70_001);
      });
    }
    return created;
  }) as typeof fs.createReadStream);
  try {
    const result = await createScreenRecordingFinalizer(host, validator).complete({
      outputPath,
      showTouches: true,
      gestureEvents: [{ kind: 'tap', tMs: 0, x: 1, y: 1 }],
      targetLabel: 'recording',
    });
    expect(advanced).toBe(true);
    expect(result.overlayWarning).toContain('failed to overlay');
    expect(fs.readdirSync(path.join(root, 'cache', 'bin'))).toEqual([]);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('raw');
    expect(fs.readdirSync(claims)).toEqual([]);
    expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
  } finally {
    vi.useRealTimers();
    spy.mockRestore();
    Object.defineProperty(process, 'platform', platform);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
