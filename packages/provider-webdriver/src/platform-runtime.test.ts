import { expect, test, vi } from 'vitest';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import { providerRuntimeOwner } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createWebDriverPlatformRuntimeOwner } from './platform-runtime.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'browserstack:lease-one',
  name: 'Remote Android',
  kind: 'device',
  target: 'mobile',
  booted: true,
};

test('direct WebDriver network uses only the canonical session log and preserves empty success', async () => {
  const run = vi.fn(async () => ({ stdout: 'must not execute', stderr: '', exitCode: 0 }));
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(run),
    owner: providerRuntimeOwner('browserstack', 'android'),
    ownsDevice: () => true,
  });
  const binding = await owner.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await expect(
    binding.operations.networkDump?.({
      sessionId: 'one',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 4000,
    }),
  ).resolves.toMatchObject({
    source: 'app-log',
    backend: 'android',
    dump: { exists: false, entries: [] },
  });
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
  expect(binding.facts.operations.appLogInspect).toMatchObject({ available: false });
  expect(run).not.toHaveBeenCalled();
});

test.each([
  ['Android', device, 'android'],
  [
    'iOS',
    {
      ...device,
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'browserstack:ios:lease-one',
      name: 'Remote iPhone',
    },
    'ios-device',
  ],
])('classifies the direct WebDriver %s network cell', async (_name, runtimeDevice, backend) => {
  const owner = createWebDriverPlatformRuntimeOwner({
    host: host(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    owner: providerRuntimeOwner('browserstack', String(_name).toLowerCase()),
    ownsDevice: () => true,
  });
  const binding = await owner.bind({
    device: runtimeDevice,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  expect(binding.facts.device.providerMode).toBe('provider-runtime');
  expect(binding.facts.operations.networkDump).toEqual({ available: true });
  await expect(
    binding.operations.networkDump?.({
      sessionId: 'one',
      maxEntries: 25,
      include: 'summary',
      maxPayloadChars: 2048,
      maxScanLines: 4000,
    }),
  ).resolves.toMatchObject({ source: 'app-log', backend });
});

function host(run: PlatformRuntimeHost['commands']['run']): PlatformRuntimeHost {
  return {
    appleTools: {
      isXcrunAvailable: async () => false,
      run: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
    },
    toolchains: { prepare: async () => {} },
    commands: { which: async () => undefined, run },
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
    networkTransports: { resolve: async () => ({ mode: 'local' }) },
  };
}
