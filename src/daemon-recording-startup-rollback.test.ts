import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { AppError } from '@agent-device/kernel/errors';
import { androidScreenRecordingDescriptorCodec } from '../packages/platform-android/src/recording/manifest.ts';
import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import { startDaemonRuntime } from '../packages/daemon/src/server/http/daemon-runtime.ts';
import * as transport from '../packages/daemon/src/server/http/transport.ts';
import { daemonRuntimeDepsFixture } from '../packages/daemon/src/__tests__/support/daemon-runtime-deps-fixture.ts';
import { makeTestScreenRecordingResource } from '../packages/daemon/src/__tests__/support/screen-recording-live-handle.ts';

vi.mock('@agent-device/host-kit/command', async (original) => ({
  ...(await original<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
}));

test('startup rollback settles the recovery validator before releasing its cache', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const stateDir = mkdtempForTestSync('startup-rollback-state-');
  const cache = mkdtempForTestSync('startup-rollback-cache-');
  const paths = resolveDaemonPaths(stateDir);
  const resource = makeTestScreenRecordingResource({
    name: 'session',
    device: { platform: 'android', id: 'emulator-5554', name: 'fixture', kind: 'emulator' },
  });
  const resourcePath = screenRecordingResourceStore.resolvePath(
    path.join(paths.sessionsDir, 'session'),
  );
  const descriptor = androidScreenRecordingDescriptorCodec.encode({
    backend: 'adb-screenrecord',
    manifestPath: '/data/local/tmp/agent-device-recording-active.json',
    outputPath: '/tmp/capture.mp4',
    scope: 'device',
    showTouches: true,
    recordOnlySession: false,
    transportMode: 'local',
  });
  expect(androidScreenRecordingDescriptorCodec.decode(descriptor)).toMatchObject({
    status: 'decoded',
  });
  screenRecordingResourceStore.write(resourcePath, {
    ...resource.envelope,
    descriptor: { version: 1, body: descriptor },
  });
  const host = createTestHostEnvironment({
    env: {
      ...process.env,
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
  const compilerSettlement = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(runCmd).mockImplementation(async (_command, _args, options) => {
    signal = options!.signal!;
    started();
    await compilerSettlement;
    throw new Error('compiler stopped');
  });
  const bindFailure = new AppError('COMMAND_FAILED', 'bind failed', { reason: 'bind_failed' });
  const listen = vi.spyOn(transport, 'listenHttpServer').mockImplementation(async () => {
    await compilerStarted;
    throw bindFailure;
  });
  try {
    let settled = false;
    const startup = startDaemonRuntime({
      host,
      stdout: { write: () => {} },
      stderr: { write: () => {} },
      composeDeps: daemonRuntimeDepsFixture({ deviceRuntimeGateway: gateway }),
    });
    const result = startup.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await compilerStarted;
    await expect.poll(() => signal.aborted).toBe(true);
    expect(settled).toBe(false);
    const bin = path.join(cache, 'bin');
    expect(fs.readdirSync(bin).some((entry) => entry.endsWith('.lock'))).toBe(true);
    expect(fs.readdirSync(bin).some((entry) => entry.startsWith('.'))).toBe(true);
    release();
    expect(await result).toBe(bindFailure);
    expect(
      fs.readdirSync(bin).some((entry) => entry.endsWith('.lock') || entry.startsWith('.')),
    ).toBe(false);
    await operationHost.screenRecording.finalize.prepare({ container: 'mp4' });
    expect(runCmd).toHaveBeenCalledOnce();
    expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'open' },
    });
  } finally {
    release();
    listen.mockRestore();
    vi.mocked(runCmd).mockReset();
    Object.defineProperty(process, 'platform', platform);
  }
});

test('rollback closes the host before a late recording import', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const stateDir = mkdtempForTestSync('startup-rollback-late-state-');
  const cache = path.join(stateDir, 'cache');
  const paths = resolveDaemonPaths(stateDir);
  const host = createTestHostEnvironment({
    env: {
      ...process.env,
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
  const listen = vi.spyOn(transport, 'listenHttpServer').mockRejectedValue(failure);
  try {
    await expect(
      startDaemonRuntime({
        host,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        composeDeps: daemonRuntimeDepsFixture({ deviceRuntimeGateway: gateway }),
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
  const host = createTestHostEnvironment({
    env: {
      ...process.env,
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
  const listen = vi.spyOn(transport, 'listenHttpServer').mockRejectedValue(failure);
  try {
    await expect(
      startDaemonRuntime({
        host,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        composeDeps: daemonRuntimeDepsFixture({ deviceRuntimeGateway: gateway }),
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
