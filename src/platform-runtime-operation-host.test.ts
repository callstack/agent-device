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

import { createPlatformRuntimeHost } from './platform-runtime-operation-host.ts';

const snapshot = {
  captureSurface: async () => ({
    backend: 'linux-atspi' as const,
    producer: 'linux-atspi' as const,
    nodes: [],
    truncated: false,
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
