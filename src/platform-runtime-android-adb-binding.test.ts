import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';

const adb = vi.hoisted(() => ({ calls: [] as string[][] }));

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...original,
    whichCmd: async (executable: string) => `/usr/bin/${executable}`,
    runCmd: async (cmd: string, args: string[]) => {
      adb.calls.push([cmd, ...args]);
      if (args.includes('query-activities')) {
        return { stdout: 'com.example.app/.MainActivity\n', stderr: '', exitCode: 0 };
      }
      if (args.includes('dumpsys')) {
        return {
          stdout: 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}\n',
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
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

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => {} },
  progress: { report: () => {} },
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
  const binding = await gateway.bind({ device, intent: { kind: 'ordinary' }, scope });

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

test('the composed gateway reads Android app state from inside the platform package', async () => {
  const gateway = createPlatformRuntimeGateway(sessionArtifacts);
  const binding = await gateway.bind({ device, intent: { kind: 'ordinary' }, scope });

  await expect(binding.operations.appState?.()).resolves.toEqual({
    package: 'com.example.app',
    activity: '.MainActivity',
  });
  expect(adb.calls).toContainEqual([
    'adb',
    '-s',
    device.id,
    'shell',
    'dumpsys',
    'window',
    'windows',
  ]);

  await gateway.shutdown();
});
