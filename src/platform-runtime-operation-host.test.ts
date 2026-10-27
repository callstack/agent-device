import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, vi } from 'vitest';

const directory = dirname(fileURLToPath(import.meta.url));

const capabilities = vi.hoisted(() => ({
  appleTools: {
    isXcrunAvailable: async () => true,
    run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  },
  toolchains: { prepare: async () => undefined },
}));

vi.mock('./platform-runtime-apple-tool-host.ts', () => ({
  createAppleToolHost: () => capabilities.appleTools,
}));
vi.mock('./platform-runtime-toolchain-host.ts', () => ({
  createHostToolchainPreparer: () => capabilities.toolchains,
}));
vi.mock('@agent-device/platform-apple/macos', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/macos')>()),
  captureMacOsSurfaceSnapshot: vi.fn(async () => ({
    backend: 'macos-helper' as const,
    producer: 'macos-helper' as const,
    nodes: [],
    truncated: false,
  })),
}));

import { captureMacOsSurfaceSnapshot } from '@agent-device/platform-apple/macos';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  createPlatformRuntimeHost,
  loadMacOsSurfaceSnapshot,
} from './platform-runtime-operation-host.ts';

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

test('operation host composes the shared lazy Apple-tool and toolchain capabilities', () => {
  const host = createPlatformRuntimeHost({
    host: createLiveTestHostEnvironment(),
    sessionsDir: '/tmp/sessions',
    resolveSessionArtifacts: () => ({
      outputPath: '/tmp/sessions/one/app.log',
      pidPath: '/tmp/sessions/one/app-log.pid',
    }),
    shutdownLoaders,
    snapshot,
  });

  expect(host.appleTools).toBe(capabilities.appleTools);
  expect(host.toolchains).toBe(capabilities.toolchains);
});

test.skipIf(process.platform === 'win32')(
  'the command port resolves executables through the host environment the host was given',
  async () => {
    // The operation host hands its own host environment to the command port. Reading the process
    // environment there (#3753) would resolve a tool this host never named, so a tool inside the one
    // directory this host names resolves and a name no PATH carries stays unresolved.
    const binDir = mkdtempForTestSync('operation-host-command-path-');
    writeFileSync(join(binDir, 'probe-tool'), '#!/bin/sh\nexit 0\n');
    chmodSync(join(binDir, 'probe-tool'), 0o755);
    const host = createPlatformRuntimeHost({
      host: { env: { PATH: binDir }, cwd: binDir },
      sessionsDir: '/tmp/sessions',
      resolveSessionArtifacts: () => ({
        outputPath: '/tmp/sessions/one/app.log',
        pidPath: '/tmp/sessions/one/app-log.pid',
      }),
      shutdownLoaders,
      snapshot,
    });

    await expect(host.commands.which('probe-tool')).resolves.toBe('probe-tool');
    await expect(
      host.commands.which('agent-device-command-runner-probe-absent'),
    ).resolves.toBeUndefined();
  },
);

test('composes focused deployment executors instead of a cross-family deployment host', () => {
  const source = readFileSync(join(directory, 'platform-runtime-operation-host.ts'), 'utf8');

  expect(source).toContain('createAppleAppDeploymentExecutor');
  expect(source).toContain('createAndroidAppDeploymentExecutor');
  expect(source).not.toContain('createHarmonyAppDeploymentExecutor');
  expect(source).not.toContain('appDeployment:');
  expect(existsSync(join(directory, 'platform-runtime-app-deployment-host.ts'))).toBe(false);
});

test('the macOS surface loader refuses a capture the owner did not route to it', async () => {
  vi.mocked(captureMacOsSurfaceSnapshot).mockClear();
  const refusal = loadMacOsSurfaceSnapshot({ depth: 2 }, undefined, process.env);
  await expect(refusal).rejects.toBeInstanceOf(TypeError);
  await expect(refusal).rejects.toThrow(
    'Apple surface capture requires a helper-routed macOS surface',
  );
  expect(captureMacOsSurfaceSnapshot).not.toHaveBeenCalled();
});

test('the macOS surface loader forwards a helper-routed surface unchanged', async () => {
  vi.mocked(captureMacOsSurfaceSnapshot).mockClear();
  const signal = new AbortController().signal;
  await loadMacOsSurfaceSnapshot({ surface: 'frontmost-app', depth: 2 }, signal, process.env);
  expect(captureMacOsSurfaceSnapshot).toHaveBeenCalledWith(
    { surface: 'frontmost-app', depth: 2 },
    signal,
    process.env,
  );
});
