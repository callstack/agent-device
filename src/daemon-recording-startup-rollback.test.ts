import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { androidRecordingDescriptorFixture, mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import { startDaemonRuntime } from '@agent-device/daemon';
import {
  failDaemonHttpListen,
  recordingDaemonDeps,
  recordingDaemonHost,
  recordingRecoveryEnvelope,
} from './__tests__/test-utils/recording-daemon.ts';

vi.mock('@agent-device/host-kit/command', async (original) => ({
  ...(await original<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
}));

test.each([false, true])(
  'startup rollback settles the recovery validator (cleanup failure: %s)',
  async (failCleanup) => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    const stateDir = mkdtempForTestSync('startup-rollback-state-');
    const cache = mkdtempForTestSync('startup-rollback-cache-');
    const paths = resolveDaemonPaths(stateDir);
    const resourcePath = screenRecordingResourceStore.resolvePath(
      path.join(paths.sessionsDir, 'session'),
    );
    const descriptor = androidRecordingDescriptorFixture;
    screenRecordingResourceStore.write(resourcePath, recordingRecoveryEnvelope(descriptor));
    expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { descriptor: { body: descriptor } },
    });
    const host = recordingDaemonHost({
      env: {
        AGENT_DEVICE_STATE_DIR: stateDir,
        AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
        AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
        AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
      },
    });
    const operationHost = createPlatformRuntimeHost({
      host,
      sessionsDir: paths.sessionsDir,
      resolveSessionArtifacts: () => ({ outputPath: '/tmp/unused', pidPath: '/tmp/unused.pid' }),
      shutdownLoaders: {} as Parameters<typeof createPlatformRuntimeHost>[0]['shutdownLoaders'],
      snapshot: {} as Parameters<typeof createPlatformRuntimeHost>[0]['snapshot'],
    });
    const gateway = createComposedPlatformRuntimeGateway({
      modules: new Map(),
      loadHost: async () => operationHost,
    });
    let signal!: AbortSignal;
    let release!: () => void;
    let started!: () => void;
    const compilerStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let releaseListener!: () => void;
    const listenerReleased = new Promise<void>((resolve) => {
      releaseListener = resolve;
    });
    const compilerSettlement = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(runCmd).mockImplementation(async (_command, _args, options) => {
      signal = options!.signal!;
      started();
      await compilerSettlement;
      throw new Error('compiler stopped');
    });
    const bindFailure = new AppError(
      'COMMAND_FAILED',
      'bind failed',
      { reason: 'bind_failed', exitCode: 7, token: 'primarysecret' },
      new Error('original bind cause'),
    );
    const originalRemove = fs.rmSync;
    const remove = vi.spyOn(fs, 'rmSync');
    if (failCleanup)
      remove.mockImplementation((target, options) => {
        if (String(target).startsWith(path.join(cache, 'bin', '.')))
          throw new Error('password=cleanupsecret');
        return originalRemove(target, options);
      });
    const listen = failDaemonHttpListen(bindFailure, {
      beforeFailure: async () => {
        await Promise.race([compilerStarted, listenerReleased]);
      },
    });
    let result: Promise<unknown> | undefined;
    try {
      let settled = false;
      const startup = startDaemonRuntime({
        host,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        composeDeps: recordingDaemonDeps(() => gateway),
      });
      result = startup.catch((error: unknown) => {
        settled = true;
        return error;
      });
      await expect.poll(() => signal?.aborted, { timeout: 1500 }).toBe(true);
      expect(settled).toBe(false);
      const bin = path.join(cache, 'bin');
      expect(fs.readdirSync(bin).some((entry) => entry.endsWith('.lock'))).toBe(true);
      expect(fs.readdirSync(bin).some((entry) => entry.startsWith('.'))).toBe(true);
      release();
      const error = await result;
      if (failCleanup) {
        expect(error).toMatchObject({
          code: bindFailure.code,
          message: bindFailure.message,
          cause: bindFailure,
          details: {
            reason: 'bind_failed',
            exitCode: 7,
            recordingCleanupFailure: {
              details: {
                shutdownFailures: [
                  {
                    details: {
                      reason: 'swift_cache_cleanup_failed',
                      shutdownFailures: [
                        { message: 'compiler stopped' },
                        {
                          details: { reason: 'swift_cache_temp_removal_failed' },
                          cause: { message: 'password=[REDACTED]' },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
        const normalized = JSON.stringify(normalizeError(error));
        expect(normalized).not.toContain('cleanupsecret');
        expect(normalized).not.toContain('primarysecret');
        expect(fs.readdirSync(bin).some((entry) => entry.startsWith('.'))).toBe(true);
      } else {
        expect(error).toBe(bindFailure);
        expect(fs.readdirSync(bin).some((entry) => entry.startsWith('.'))).toBe(false);
      }
      expect(fs.readdirSync(bin).some((entry) => entry.endsWith('.lock'))).toBe(false);
      if (!failCleanup) await operationHost.screenRecording.finalize.prepare({ container: 'mp4' });
      expect(runCmd).toHaveBeenCalledOnce();
      expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
        status: 'decoded',
        envelope: { lifecycle: 'open' },
      });
    } finally {
      release();
      releaseListener();
      await result;
      remove.mockRestore();
      fs.rmSync(cache, { recursive: true, force: true });
      listen.mockRestore();
      vi.mocked(runCmd).mockReset();
      Object.defineProperty(process, 'platform', platform);
    }
  },
);

test('rollback closes the host before a late recording import', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const stateDir = mkdtempForTestSync('startup-rollback-late-state-');
  const cache = path.join(stateDir, 'cache');
  const paths = resolveDaemonPaths(stateDir);
  const host = recordingDaemonHost({
    env: {
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
  });
  const operationHost = createPlatformRuntimeHost({
    host,
    sessionsDir: paths.sessionsDir,
    resolveSessionArtifacts: () => ({ outputPath: '/tmp/unused', pidPath: '/tmp/unused.pid' }),
    shutdownLoaders: {} as Parameters<typeof createPlatformRuntimeHost>[0]['shutdownLoaders'],
    snapshot: {} as Parameters<typeof createPlatformRuntimeHost>[0]['snapshot'],
  });
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map(),
    loadHost: async () => operationHost,
  });
  const failure = new Error('bind failed');
  const listen = failDaemonHttpListen(failure);
  try {
    await expect(
      startDaemonRuntime({
        host,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        composeDeps: recordingDaemonDeps(() => gateway),
      }),
    ).rejects.toBe(failure);
    await operationHost.screenRecording.finalize.prepare({ container: 'mp4' });
    expect(runCmd).not.toHaveBeenCalled();
    expect(fs.existsSync(cache)).toBe(false);
  } finally {
    listen.mockRestore();
    vi.mocked(runCmd).mockReset();
    Object.defineProperty(process, 'platform', platform);
  }
});

test('startup failure retains nested recording cleanup diagnostics', async () => {
  const stateDir = mkdtempForTestSync('startup-rollback-failure-');
  const host = recordingDaemonHost({
    env: {
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
  });
  const cleanup = new AppError(
    'COMMAND_FAILED',
    'cache cleanup failed',
    { reason: 'swift_cache_cleanup_failed' },
    new AggregateError([
      new AppError('COMMAND_FAILED', 'temp failed', { reason: 'swift_cache_temp_removal_failed' }),
    ]),
  );
  const operationHost = createPlatformRuntimeHost({
    host,
    sessionsDir: resolveDaemonPaths(stateDir).sessionsDir,
    resolveSessionArtifacts: () => ({ outputPath: '/tmp/unused', pidPath: '/tmp/unused.pid' }),
    shutdownLoaders: {} as Parameters<typeof createPlatformRuntimeHost>[0]['shutdownLoaders'],
    snapshot: {} as Parameters<typeof createPlatformRuntimeHost>[0]['snapshot'],
  });
  const resources = (
    await import('./platform-runtime-application-resources.ts')
  ).createApplicationResourceLifecycle({
    android: operationHost.androidApplications,
    apple: operationHost.appleApplications,
    recording: {
      finalize: operationHost.screenRecording.finalize,
      closeValidatorPreparation: async () => {
        throw cleanup;
      },
    },
  });
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map(),
    loadHost: async () => ({ ...operationHost, applicationResources: resources }),
  });
  const failure = new AppError('COMMAND_FAILED', 'bind failed', {
    reason: 'bind_failed',
    exitCode: 7,
  });
  const listen = failDaemonHttpListen(failure);
  try {
    await expect(
      startDaemonRuntime({
        host,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        composeDeps: recordingDaemonDeps(() => gateway),
      }),
    ).rejects.toMatchObject({
      code: 'COMMAND_FAILED',
      message: 'bind failed',
      cause: failure,
      details: {
        reason: 'bind_failed',
        exitCode: 7,
        recordingCleanupFailure: {
          details: {
            shutdownFailures: [
              {
                details: {
                  reason: 'swift_cache_cleanup_failed',
                  shutdownFailures: [{ details: { reason: 'swift_cache_temp_removal_failed' } }],
                },
              },
            ],
          },
        },
      },
    });
  } finally {
    listen.mockRestore();
  }
});

test('a daemon admits requests while its recovery compiler remains pending', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const stateDir = mkdtempForTestSync('startup-warm-admission-');
  const cache = mkdtempForTestSync('startup-warm-cache-');
  const paths = resolveDaemonPaths(stateDir);
  const resourcePath = screenRecordingResourceStore.resolvePath(
    path.join(paths.sessionsDir, 'session'),
  );
  const descriptor = androidRecordingDescriptorFixture;
  screenRecordingResourceStore.write(resourcePath, recordingRecoveryEnvelope(descriptor));
  const originalResource = fs.readFileSync(resourcePath);
  const host = recordingDaemonHost({
    env: {
      AGENT_DEVICE_STATE_DIR: stateDir,
      AGENT_DEVICE_SWIFT_CACHE_DIR: cache,
      AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS: '0',
      AGENT_DEVICE_DAEMON_SERVER_MODE: 'http',
    },
  });
  const operationHost = createPlatformRuntimeHost({
    host,
    sessionsDir: paths.sessionsDir,
    resolveSessionArtifacts: () => ({ outputPath: '/tmp/unused', pidPath: '/tmp/unused.pid' }),
    shutdownLoaders: {} as Parameters<typeof createPlatformRuntimeHost>[0]['shutdownLoaders'],
    snapshot: {} as Parameters<typeof createPlatformRuntimeHost>[0]['snapshot'],
  });
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map(),
    loadHost: async () => operationHost,
  });
  let release!: () => void;
  const compilerSettlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  let signal: AbortSignal | undefined;
  vi.mocked(runCmd).mockImplementation(async (_command, _args, options) => {
    signal = options!.signal!;
    await compilerSettlement;
    throw new Error('compiler stopped');
  });
  let runtime: Awaited<ReturnType<typeof startDaemonRuntime>> | undefined;
  let startup: Promise<Awaited<ReturnType<typeof startDaemonRuntime>>> | undefined;
  try {
    startup = startDaemonRuntime({
      host,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      composeDeps: recordingDaemonDeps(() => gateway),
    });
    await expect.poll(() => signal !== undefined, { timeout: 1500 }).toBe(true);
    runtime = await Promise.race([
      startup,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('startup waited for compiler')), 1500);
        timer.unref();
        void startup!.finally(() => clearTimeout(timer)).catch(() => {});
      }),
    ]);
    const response = await fetch(`http://127.0.0.1:${runtime.httpPort}/rpc`, {
      method: 'POST',
      signal: AbortSignal.timeout(2000),
      headers: { authorization: `Bearer ${runtime.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'warm',
        method: 'agent_device.command',
        params: { command: 'session_list', meta: { requestId: 'warm' } },
      }),
    });
    const body = (await response.json()) as { result?: { ok: boolean }; error?: unknown };
    expect(body.error).toBeUndefined();
    expect(body.result?.ok).toBe(true);
    expect(signal!.aborted).toBe(false);
    expect(runCmd).toHaveBeenCalledOnce();
    expect(fs.readFileSync(resourcePath)).toEqual(originalResource);
  } finally {
    release();
    if (!runtime && startup) runtime = await startup.catch(() => undefined);
    await runtime?.close();
    vi.mocked(runCmd).mockReset();
    Object.defineProperty(process, 'platform', platform);
  }
});
