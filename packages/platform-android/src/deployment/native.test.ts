import { beforeEach, expect, test, vi } from 'vitest';
import type { AndroidToolHost, PlatformRuntimeHost } from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  installAndroidArtifact,
  pushAndroidNotification,
  uninstallAndroidPackage,
} from './native.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Android',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

const run = vi.fn();
const dispose = vi.fn(async () => {});

function hostFixture(options: { bundletool?: boolean; bundletoolJar?: string } = {}) {
  return {
    commands: {
      which: async (name: string) =>
        name === 'bundletool' && options.bundletool ? 'bundletool' : undefined,
      run,
    },
    androidDeployment: { bundletoolJar: options.bundletoolJar },
    androidTools: {
      probeClipboardShellSupport: async () => 'supported' as const,
      runAdb: async (_device, args, commandOptions, signal) =>
        await run({ executable: 'adb', args, ...commandOptions }, signal),
      installPackage: async (_device, packagePath, options, signal) =>
        await run(
          {
            executable: 'adb-install',
            args: [packagePath],
            replace: options.replace,
          },
          signal,
        ),
      installBundle: async () => false,
    } satisfies AndroidToolHost,
    temporaryFiles: {
      create: async () => ({
        path: '/tmp/bundle.apks',
        readText: async () => '',
        writeText: async () => {},
        [Symbol.asyncDispose]: dispose,
      }),
    },
  } as unknown as PlatformRuntimeHost;
}

beforeEach(() => {
  vi.clearAllMocks();
  run.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

test('constructs a signal-bound adb install in the Android package', async () => {
  const host = hostFixture();
  const signal = new AbortController().signal;

  await expect(
    installAndroidArtifact(host, device, '/tmp/app.apk', 'com.example.app', signal),
  ).resolves.toBe('com.example.app');

  expect(run).toHaveBeenCalledWith(
    expect.objectContaining({
      executable: 'adb-install',
      args: ['/tmp/app.apk'],
      replace: true,
    }),
    signal,
  );
});

test('owns bundletool command construction and temporary output cleanup', async () => {
  const host = hostFixture({ bundletool: true });
  const signal = new AbortController().signal;

  await installAndroidArtifact(host, device, '/tmp/app.aab', 'com.example.app', signal);

  expect(run.mock.calls.map(([request]) => request.args[0])).toEqual([
    'build-apks',
    'install-apks',
  ]);
  expect(run.mock.calls.every(([, actualSignal]) => actualSignal === signal)).toBe(true);
  expect(dispose).toHaveBeenCalledOnce();
});

test('preserves missing-package uninstall and typed push extras', async () => {
  const host = hostFixture();
  const signal = new AbortController().signal;
  run.mockResolvedValueOnce({ stdout: '', stderr: 'Unknown package', exitCode: 1 });

  await expect(
    uninstallAndroidPackage(host, device, 'com.missing', signal),
  ).resolves.toBeUndefined();
  await expect(
    pushAndroidNotification(
      host,
      device,
      {
        appId: 'com.example.app',
        payload: { extras: { title: 'Hello', enabled: true, count: 2 } },
      },
      signal,
    ),
  ).resolves.toEqual({ action: 'com.example.app.TEST_PUSH', extrasCount: 3 });

  expect(run).toHaveBeenLastCalledWith(
    expect.objectContaining({
      args: expect.arrayContaining(['--es', 'title', 'Hello', '--ez', 'enabled', 'true']),
    }),
    signal,
  );
});
