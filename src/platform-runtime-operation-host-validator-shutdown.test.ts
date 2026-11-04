import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';
import { createOwnedFakeCompiler } from './owned-fake-compiler.fixtures.ts';

const snapshot = {
  captureSurface: async () => ({
    backend: 'linux-atspi' as const,
    producer: 'linux-atspi' as const,
    nodes: [],
    truncated: false,
  }),
  presentIosAcquisition: async () => ({
    backend: 'xctest' as const,
    producer: 'appium-source' as const,
    nodes: [],
  }),
};

const shutdownLoaders = {
  apple: async () => ({
    canShutdownTarget: () => true,
    shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
  }),
  android: async () => ({
    canShutdownTarget: () => true,
    shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
  }),
};

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
// The only compiler this file can learn about is one its own spawn started.
const compiler = createOwnedFakeCompiler('operation-host-validator-shutdown-');
const hostEnvironment: HostEnvironment = {
  env: {
    PATH: compiler.toolchainDir,
    ...compiler.env,
    AGENT_DEVICE_CLAIMS_DIR: path.join(path.dirname(compiler.cacheDir), 'claims'),
  },
  cwd: compiler.toolchainDir,
};

beforeAll(() => {
  // Swift preparation compiles only on a macOS host, so the host under test reads as one. The fake
  // tool it spawns stays this worker's own child, so the unit lane's signal guard still applies.
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
});

afterAll(() => {
  Object.defineProperty(process, 'platform', originalPlatform);
});

const validatorShutdownTest = test.skipIf(process.platform === 'win32');

validatorShutdownTest(
  'daemon shutdown stops the validator compiler a recording left running in the background',
  async () => {
    const host = createRuntimeHost(
      hostEnvironment,
      path.join(compiler.toolchainDir, 'sessions'),
      'sessions',
    );

    await host.screenRecording.finalize.prepare({ container: 'mp4' });
    await expect.poll(() => compiler.runningCompilerPids()).toHaveLength(1);
    const compilerPid = compiler.runningCompilerPids()[0]!;
    // The compile belongs to no request: the warm-up already returned, the compiler is still
    // running, it holds the Swift cache lock, and its unpublished output sits inside the cache.
    expect(compiler.cacheBinEntries().some((entry) => entry.endsWith('.lock'))).toBe(true);
    const attempts = path.join(compiler.cacheDir, 'attempts');
    const [attempt] = fs.readdirSync(attempts);
    expect(fs.existsSync(path.join(attempts, attempt!, 'alias', 'work'))).toBe(true);

    await host.applicationResources.finalizeDaemonShutdown();

    // The shutdown owns what no request ever did: the compiler is gone and left neither its lock
    // nor its unpublished output behind.
    expect(compiler.runningCompilerPids()).not.toContain(compilerPid);
    await expect.poll(() => compiler.runningCompilerPids()).toEqual([]);
    expect(compiler.cacheBinEntries().some((entry) => entry.endsWith('.lock'))).toBe(false);
    expect(compiler.cacheBinEntries().filter((entry) => entry.startsWith('.'))).toEqual([]);
    expect(fs.existsSync(path.join(attempts, attempt!, 'pending.json'))).toBe(true);
    expect(fs.lstatSync(path.join(attempts, attempt!, 'alias', 'work')).isFile()).toBe(true);
  },
);

validatorShutdownTest(
  'a shutdown that never recorded starts no compiler and loads no Swift preparation',
  async () => {
    const idleCompiler = createOwnedFakeCompiler('operation-host-validator-idle-');
    const host = createRuntimeHost(
      {
        env: {
          PATH: idleCompiler.toolchainDir,
          ...idleCompiler.env,
          AGENT_DEVICE_CLAIMS_DIR: path.join(path.dirname(idleCompiler.cacheDir), 'claims'),
        },
        cwd: '/tmp',
      },
      '/tmp/platform-runtime-idle-sessions',
      'idle-sessions',
    );

    await expect(host.applicationResources.finalizeDaemonShutdown()).resolves.toEqual([]);

    // Nothing recorded, so shutdown reached no Swift material at all: no cache was created, and no
    // compiler existed for it to stop.
    expect(idleCompiler.runningCompilerPids()).toEqual([]);
    expect(fs.existsSync(idleCompiler.cacheDir)).toBe(false);
  },
);

validatorShutdownTest(
  'a warm-up that arrives after shutdown closes without starting a compiler',
  async () => {
    const lateCompiler = createOwnedFakeCompiler('operation-host-validator-late-');
    const host = createRuntimeHost(
      {
        env: {
          PATH: lateCompiler.toolchainDir,
          ...lateCompiler.env,
          AGENT_DEVICE_CLAIMS_DIR: path.join(path.dirname(lateCompiler.cacheDir), 'claims'),
        },
        cwd: '/tmp',
      },
      '/tmp/platform-runtime-late-sessions',
      'late-sessions',
    );

    await host.applicationResources.finalizeDaemonShutdown();
    await host.screenRecording.finalize.prepare({ container: 'mp4' });

    // A warm-up that reaches a closed host must not leave a compiler nobody owns: the closed host
    // hands out an owner that refuses to compile, so no Swift cache is even created. The warm-up
    // starts its compile outside the call that asked for it, so keep watching past its return.
    await expect
      .poll(() => lateCompiler.runningCompilerPids(), { timeout: 2_000, interval: 50 })
      .toEqual([]);
    expect(fs.existsSync(lateCompiler.cacheDir)).toBe(false);
  },
);

validatorShutdownTest(
  'a shutdown while preparation is still loading closes the preparation it produces',
  async () => {
    const racingCompiler = createOwnedFakeCompiler('operation-host-validator-racing-');
    const host = createRuntimeHost(
      {
        env: {
          PATH: racingCompiler.toolchainDir,
          ...racingCompiler.env,
          AGENT_DEVICE_CLAIMS_DIR: path.join(path.dirname(racingCompiler.cacheDir), 'claims'),
        },
        cwd: '/tmp',
      },
      '/tmp/platform-runtime-racing-sessions',
      'racing-sessions',
    );

    // The warm-up is still importing its Swift material when the shutdown runs, so the preparation
    // owner is created after the host is already closed. Shutdown must still settle it.
    const warming = host.screenRecording.finalize.prepare({ container: 'mp4' });
    await host.applicationResources.finalizeDaemonShutdown();
    await warming;

    // The compile that the late import started is gone and left neither its lock nor its
    // unpublished output behind.
    await expect.poll(() => racingCompiler.runningCompilerPids(), { timeout: 5_000 }).toEqual([]);
    expect(racingCompiler.cacheBinEntries().some((entry) => entry.endsWith('.lock'))).toBe(false);
    expect(racingCompiler.cacheBinEntries().filter((entry) => entry.startsWith('.'))).toEqual([]);
  },
);

function createRuntimeHost(host: HostEnvironment, sessionsDir: string, sessionPrefix: string) {
  return createPlatformRuntimeHost({
    host,
    sessionsDir,
    resolveSessionArtifacts: (sessionId) => ({
      outputPath: `${sessionsDir}/${sessionPrefix}/${sessionId}/app.log`,
      pidPath: `${sessionsDir}/${sessionPrefix}/${sessionId}/app-log.pid`,
    }),
    shutdownLoaders,
    snapshot,
  });
}
