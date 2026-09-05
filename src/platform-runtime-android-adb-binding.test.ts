import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { afterEach, expect, test, vi } from 'vitest';

const adb = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...original,
    whichCmd: async (executable: string) => `/usr/bin/${executable}`,
    runCmd: async (cmd: string, args: string[]) => {
      adb.calls.push([cmd, ...args]);
      return args.includes('query-activities')
        ? { stdout: 'com.example.app/.MainActivity\n', stderr: '', exitCode: 0 }
        : { stdout: '', stderr: '', exitCode: 0 };
    },
  };
});

import { createPlatformRuntimeGateway } from './platform-runtime.ts';

const sessionArtifacts = {
  sessionsDir: '/sessions',
  resolveSessionArtifacts: () => ({
    outputPath: '/sessions/one/app.log',
    pidPath: '/sessions/one/app-log.pid',
  }),
};

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

test('the composed gateway lists Android apps from inside the platform package', async () => {
  const gateway = createPlatformRuntimeGateway(sessionArtifacts);
  const binding = await gateway.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });

  await expect(binding.operations.listApps?.({ device, filter: 'all' })).resolves.toEqual([
    { id: 'com.example.app', name: 'Example' },
  ]);
  expect(adb.calls).toContainEqual([
    'adb',
    '-s',
    device.id,
    'shell',
    'cmd',
    'package',
    'query-activities',
    '--brief',
    '-a',
    'android.intent.action.MAIN',
    '-c',
    'android.intent.category.LAUNCHER',
  ]);

  await gateway.shutdown();
});

afterEach(() => {
  vi.doUnmock('./platform-runtime-android-adb-host.ts');
  vi.doUnmock('@agent-device/platform-android');
  vi.resetModules();
});

test('the root binds the adb host before it loads the Android runtime module', async () => {
  const order: string[] = [];
  vi.resetModules();
  vi.doMock('./platform-runtime-android-adb-host.ts', () => {
    order.push('adb-host');
    return {};
  });
  vi.doMock('@agent-device/platform-android', async (importOriginal) => {
    const original = await importOriginal<typeof import('@agent-device/platform-android')>();
    return {
      ...original,
      runtimeModule: Object.freeze({
        ...original.runtimeModule,
        loadRuntime: async (host: PlatformRuntimeHost) => {
          order.push('android-runtime');
          return await original.runtimeModule.loadRuntime(host);
        },
      }),
    };
  });

  const { createPlatformRuntimeGateway: create } = await import('./platform-runtime.ts');
  const gateway = create(sessionArtifacts);
  await gateway.inspectFacts(device).catch(() => {});

  expect(order).toEqual(['adb-host', 'android-runtime']);
  await gateway.shutdown();
});
