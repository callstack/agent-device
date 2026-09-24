import { existsSync, readFileSync } from 'node:fs';
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

test('composes focused deployment executors instead of a cross-family deployment host', () => {
  const source = readFileSync(join(directory, 'platform-runtime-operation-host.ts'), 'utf8');

  expect(source).toContain('createAppleAppDeploymentExecutor');
  expect(source).toContain('createAndroidAppDeploymentExecutor');
  expect(source).not.toContain('createHarmonyAppDeploymentExecutor');
  expect(source).not.toContain('appDeployment:');
  expect(existsSync(join(directory, 'platform-runtime-app-deployment-host.ts'))).toBe(false);
});

test.each([undefined, 'app'] as const)(
  'the macOS surface loader refuses a %s surface the owner routes to the runner',
  async (surface) => {
    vi.mocked(captureMacOsSurfaceSnapshot).mockClear();
    const refusal = loadMacOsSurfaceSnapshot({ surface });
    await expect(refusal).rejects.toBeInstanceOf(TypeError);
    await expect(refusal).rejects.toThrow(
      'Apple surface capture requires a helper-routed macOS surface',
    );
    expect(captureMacOsSurfaceSnapshot).not.toHaveBeenCalled();
  },
);

test('the macOS surface loader forwards a helper-routed surface unchanged', async () => {
  vi.mocked(captureMacOsSurfaceSnapshot).mockClear();
  const signal = new AbortController().signal;
  await loadMacOsSurfaceSnapshot({ surface: 'frontmost-app', depth: 2 }, signal);
  expect(captureMacOsSurfaceSnapshot).toHaveBeenCalledWith(
    { surface: 'frontmost-app', depth: 2 },
    signal,
  );
});
