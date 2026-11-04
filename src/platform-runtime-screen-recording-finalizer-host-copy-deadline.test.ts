import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(async (_command: string, args: readonly string[]) => {
    const output = args[args.indexOf('-o') + 1]!;
    fs.writeFileSync(output, 'compiled', { mode: 0o755 });
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
