import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { runCmd } from '@agent-device/host-kit/command';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import { startDaemonRuntime } from '@agent-device/daemon';
import {
  failDaemonHttpListen,
  recordingDaemonDeps,
} from './__tests__/test-utils/recording-daemon.ts';

const gate = vi.hoisted(() => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { pending, release, entered: false };
});
vi.mock('./platform-runtime-screen-recording-finalizer-host.ts', async (original) => {
  gate.entered = true;
  await gate.pending;
  return await original<typeof import('./platform-runtime-screen-recording-finalizer-host.ts')>();
});
vi.mock('@agent-device/host-kit/command', async (original) => ({
  ...(await original<typeof import('@agent-device/host-kit/command')>()),
  runCmd: vi.fn(),
}));
vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  prepareIosRunner: vi.fn(async () => ({
    runner: { currentUptimeMs: 42 },
    connectMs: 3,
    healthCheckMs: 3,
  })),
}));

test('rollback closes a recording import already started by the composed runner caller', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  const stateDir = mkdtempForTestSync('startup-import-race-');
  const cache = path.join(stateDir, 'cache');
  const paths = resolveDaemonPaths(stateDir);
  const host = createTestHostEnvironment({
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
  const failure = new Error('startup after listen failed');
  let caller: Promise<unknown> | undefined;
  const listen = failDaemonHttpListen(failure, {
    bindFirst: true,
    beforeFailure: async () => {
      caller = operationHost.appleApplications.prepareRunner(
        {
          platform: 'apple',
          appleOs: 'ios',
          id: 'sim-1',
          name: 'fixture',
          kind: 'simulator',
          booted: true,
        },
        { timeoutMs: 10000, execution: {} },
        new AbortController().signal,
      );
      await expect.poll(() => gate.entered, { timeout: 2000 }).toBe(true);
    },
  });
  try {
    await expect(
      startDaemonRuntime({
        host,
        stdout: { write: () => {} },
        stderr: { write: () => {} },
        composeDeps: recordingDaemonDeps(() => gateway),
      }),
    ).rejects.toBe(failure);
    expect(gate.entered).toBe(true);
    gate.release();
    await caller;
    await operationHost.screenRecording.finalize.prepare({ container: 'mp4' });
    expect(runCmd).not.toHaveBeenCalled();
    expect(fs.existsSync(cache)).toBe(false);
  } finally {
    gate.release();
    await caller?.catch(() => {});
    listen.mockRestore();
    Object.defineProperty(process, 'platform', platform);
  }
});
