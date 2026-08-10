import { expect, test, vi } from 'vitest';

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

test('operation host composes the shared lazy Apple-tool and toolchain capabilities', () => {
  const host = createPlatformRuntimeHost({
    sessionsDir: '/tmp/sessions',
    resolveSessionArtifacts: () => ({
      outputPath: '/tmp/sessions/one/app.log',
      pidPath: '/tmp/sessions/one/app-log.pid',
    }),
  });

  expect(host.appleTools).toBe(capabilities.appleTools);
  expect(host.toolchains).toBe(capabilities.toolchains);
});
