import { expect, test, vi } from 'vitest';
import type { NetworkProviderDump, PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createWebPlatformRuntime } from './runtime.ts';

const device: DeviceInfo = {
  platform: 'web',
  id: 'web',
  name: 'Browser',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

test('preserves a narrow web provider dump including empty successful entries', async () => {
  const dump: NetworkProviderDump = vi.fn(async () => ({
    backend: 'fixture-web',
    entries: [],
    notes: ['provider note'],
  }));
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed', dump })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });

  await expect(binding.operations.networkDump?.(input())).resolves.toEqual({
    source: 'provider',
    backend: 'fixture-web',
    entries: [],
    notes: ['provider note'],
  });
  expect(binding.facts.device.providerMode).toBe('transport-composed');
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
});

test('keeps a web transport without dumpNetwork unavailable instead of throwing a stub', async () => {
  const binding = await createWebPlatformRuntime(host({ mode: 'transport-composed' })).bind({
    device,
    intent: { kind: 'ordinary' },
    scope: scope(),
  });
  expect(binding.operations.networkDump).toBeUndefined();
  expect(binding.facts.operations.networkDump).toMatchObject({
    available: false,
    reason: 'owner-capability-missing',
    hint: 'network is not supported by this web provider',
  });
});

function input() {
  return {
    sessionId: 'one',
    maxEntries: 25,
    include: 'summary' as const,
    maxPayloadChars: 2048,
    maxScanLines: 4000,
  };
}

function scope() {
  return {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

function host(
  transport: Awaited<ReturnType<PlatformRuntimeHost['networkTransports']['resolve']>>,
): PlatformRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    toolchains: { prepare: async () => {} },
    commands: {
      which: async () => undefined,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    artifacts: {
      resolveSession: () => ({
        outputPath: '/sessions/one/app.log',
        pidPath: '/sessions/one/app-log.pid',
      }),
    },
    outputs: {
      openAppend: async () => {
        throw new Error('unused');
      },
      readTail: async () => '',
    },
    processes: {
      start: async () => {
        throw new Error('unused');
      },
      readMarker: async () => ({ status: 'missing' }),
      clearMarker: async () => {},
      inspect: async () => 'missing',
      terminate: async () => 'already-missing',
    },
    processTransports: { resolve: async () => ({ mode: 'local' }) },
    clock: { now: () => 1, sleep: async () => {} },
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: { resolve: async () => transport },
  };
}
