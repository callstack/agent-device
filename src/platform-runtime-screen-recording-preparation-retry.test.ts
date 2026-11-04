import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { runCmd } from '@agent-device/host-kit/command';
import { createVideoValidatorPreparation } from '@agent-device/capture-kit/recording-video';
import type {
  AndroidApplicationTools,
  AppleApplicationTools,
} from '@agent-device/contracts/application-lifecycle-runtime';
import { createScreenRecordingFinalizer } from './platform-runtime-screen-recording-finalizer-host.ts';
import { createApplicationResourceLifecycle } from './platform-runtime-application-resources.ts';

vi.mock(import('@agent-device/host-kit/command'), async (importOriginal) => ({
  ...(await importOriginal()),
  runCmd: vi.fn(),
}));

test.each(['recovered', 'unresolved', 'retry-again', 'lock'] as const)(
  'warm preparation reconciles only proven cleanup obligations: %s',
  async (scenario) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const root = mkdtempForTestSync('validator-owner-retry-');
    const claims = path.join(root, 'claims');
    const cache = path.join(root, 'cache');
    const sentinel = path.join(root, 'sentinel');
    fs.mkdirSync(claims);
    fs.mkdirSync(sentinel);
    fs.writeFileSync(path.join(sentinel, 'keep'), 'untouched');
    const host = {
      cwd: root,
      env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claims, AGENT_DEVICE_SWIFT_CACHE_DIR: cache },
    };
    const preparation = createVideoValidatorPreparation(host);
    const finalizer = createScreenRecordingFinalizer(host, preparation);
    const resources = createApplicationResourceLifecycle({
      android: {} as AndroidApplicationTools,
      apple: {
        finalizeRunnerSessionsForShutdown: async () => [],
      } as unknown as AppleApplicationTools,
      recording: { finalize: finalizer, closeValidatorPreparation: () => preparation.close() },
    });
    let finishCompiler!: () => void;
    let compilerEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      compilerEntered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      finishCompiler = resolve;
    });
    let attemptDirectory = '';
    let executable = '';
    let failures = 0;
    let blockJournal = true;
    vi.mocked(runCmd)
      .mockReset()
      .mockImplementation(async (command, args) => {
        if (command !== 'xcrun') return { exitCode: 0, stdout: '', stderr: '' };
        const output = args[args.indexOf('-o') + 1]!;
        attemptDirectory = path.dirname(path.dirname(path.dirname(output)));
        executable = path.join(cache, 'bin', path.basename(output));
        compilerEntered();
        await blocked;
        fs.writeFileSync(output, 'compiled validator', { mode: 0o755 });
        if (scenario === 'lock') {
          const owner = `${executable}.lock/owner.json`;
          fs.unlinkSync(owner);
          fs.mkdirSync(owner);
        }
        return { exitCode: 0, stdout: '', stderr: '' };
      });
    let sweepClosed!: () => void;
    const sweep = new Promise<void>((resolve) => {
      sweepClosed = resolve;
    });
    const openDir = fs.promises.opendir;
    let observedSweep = false;
    const openSpy = vi.spyOn(fs.promises, 'opendir').mockImplementation((async (
      ...args: Parameters<typeof openDir>
    ) => {
      const dir = await openDir(...args);
      if (!observedSweep && args[0] === path.join(cache, 'pending-attempts')) {
        observedSweep = true;
        const close = dir.close.bind(dir);
        dir.close = (async () => {
          await close();
          sweepClosed();
        }) as typeof dir.close;
      }
      return dir;
    }) as typeof fs.promises.opendir);
    const rename = fs.renameSync;
    const renameSpy = vi.spyOn(fs, 'renameSync').mockImplementation(((from, to) => {
      if (
        blockJournal &&
        attemptDirectory &&
        to === path.join(attemptDirectory, 'pending.json') &&
        (scenario === 'unresolved' || scenario === 'retry-again' || failures === 0)
      ) {
        failures++;
        throw Object.assign(new Error('fixture'), { code: 'ENOSPC' });
      }
      return rename(from, to);
    }) as typeof fs.renameSync);
    try {
      const first = preparation.prepare().catch((error: unknown) => error);
      await entered;
      await sweep;
      await new Promise<void>((resolve) => setImmediate(resolve));
      const attemptId = path.basename(attemptDirectory);
      console.log('validator retry fixture', {
        root,
        claims,
        cache,
        sentinel,
        attemptId,
        scenario,
      });
      finishCompiler();
      const failure = await first;
      expect(failure).toMatchObject({
        details: {
          reason: 'swift_cache_cleanup_failed',
          cleanupFailures: expect.arrayContaining([
            expect.objectContaining({
              reason: 'swift_cache_temp_removal_failed',
              attemptId,
              code: 'ENOSPC',
            }),
          ]),
        },
      });
      expect(fs.existsSync(executable)).toBe(true);
      expect(fs.lstatSync(path.join(attemptDirectory, 'alias', 'work')).isSymbolicLink()).toBe(
        true,
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(attemptDirectory, 'pending.json'), 'utf8')).closed,
      ).toBe(false);
      await resources.prepareRecordingRecovery();
      if (scenario === 'retry-again') {
        await preparation.prepare();
        expect(failures).toBeGreaterThanOrEqual(2);
        expect(fs.existsSync(path.join(cache, 'pending-attempts', attemptId))).toBe(true);
        blockJournal = false;
        await resources.prepareRecordingRecovery();
        await preparation.prepare();
      }
      if (scenario === 'unresolved') {
        await vi.waitFor(() => expect(failures).toBeGreaterThanOrEqual(2));
        const outputPath = path.join(root, 'recording.mp4');
        fs.writeFileSync(
          outputPath,
          Buffer.from('0000000c6674797069736f6d000000086d6f6f76', 'hex'),
        );
        await finalizer.complete({
          outputPath,
          showTouches: false,
          gestureEvents: [],
          targetLabel: 'recording',
        });
        const otherAttempt = fs
          .readdirSync(path.join(cache, 'attempts'))
          .find((name) => name.startsWith('validator-'));
        expect(otherAttempt).toBeTruthy();
        await vi.waitFor(() =>
          expect(fs.lstatSync(path.join(cache, 'attempts', otherAttempt!, 'data')).isFile()).toBe(
            true,
          ),
        );
        expect(fs.existsSync(path.join(cache, 'pending-attempts', attemptId))).toBe(true);
        await expect(resources.finalizeDaemonShutdown()).rejects.toMatchObject({
          details: { reason: 'application_resource_shutdown_failed' },
        });
        expect(fs.lstatSync(path.join(attemptDirectory, 'alias', 'work')).isSymbolicLink()).toBe(
          true,
        );
        expect(fs.existsSync(path.join(cache, 'pending-attempts', attemptId))).toBe(true);
        blockJournal = false;
        await expect(resources.finalizeDaemonShutdown()).resolves.toEqual([]);
      } else {
        await vi.waitFor(() => {
          expect(fs.lstatSync(path.join(attemptDirectory, 'data')).isFile()).toBe(true);
          expect(fs.existsSync(path.join(cache, 'pending-attempts', attemptId))).toBe(false);
        });
        const stat = fs.lstatSync(path.join(attemptDirectory, 'data'), { bigint: true });
        const record = JSON.parse(
          fs.readFileSync(path.join(attemptDirectory, 'pending.json'), 'utf8'),
        );
        expect(record.closed).toBe(true);
        expect(record.dataTombstone).toEqual({ device: String(stat.dev), inode: String(stat.ino) });
        if (scenario === 'lock') {
          await expect(resources.finalizeDaemonShutdown()).rejects.toMatchObject({
            details: {
              reason: 'application_resource_shutdown_failed',
              shutdownFailures: [
                expect.objectContaining({
                  details: {
                    reason: 'swift_cache_cleanup_failed',
                    cleanupFailures: [
                      expect.objectContaining({ reason: 'swift_cache_lock_release_failed' }),
                    ],
                  },
                }),
              ],
            },
          });
        } else await expect(resources.finalizeDaemonShutdown()).resolves.toEqual([]);
      }
      expect(vi.mocked(runCmd).mock.calls.filter(([command]) => command === 'xcrun')).toHaveLength(
        1,
      );
      if (scenario !== 'unresolved')
        expect(fs.readdirSync(path.join(cache, 'attempts'))).toEqual([attemptId]);
      expect(fs.readdirSync(claims)).toEqual([]);
      expect(fs.readFileSync(path.join(sentinel, 'keep'), 'utf8')).toBe('untouched');
    } finally {
      finishCompiler?.();
      blockJournal = false;
      renameSpy.mockRestore();
      openSpy.mockRestore();
      await preparation.close().catch(() => {});
      Object.defineProperty(process, 'platform', platform);
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15000,
);
