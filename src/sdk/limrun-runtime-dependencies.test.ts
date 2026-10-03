import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';

const moduleLoads = vi.hoisted(() => ({
  androidAppHelpers: 0,
  androidLogcat: 0,
  appleAppResolution: 0,
  appleInstallArtifact: 0,
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {},
}));

vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    listAndroidAppsWithAdb: vi.fn(async () => {
      moduleLoads.androidAppHelpers += 1;
      return [{ package: 'com.example.app', name: 'Example' }];
    }),
    captureAndroidLogcatWithAdb: vi.fn(async () => {
      moduleLoads.androidLogcat += 1;
      return 'log line\n';
    }),
  };
});

vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>()),
  resolveIosAppAlias: vi.fn((app: string) => {
    moduleLoads.appleAppResolution += 1;
    return `resolved:${app}`;
  }),
}));

vi.mock('@agent-device/platform-apple/install-artifact', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/platform-apple/install-artifact')>()),
  readIosBundleInfo: vi.fn(async () => {
    moduleLoads.appleInstallArtifact += 1;
    return { appName: 'Example' };
  }),
}));

test('Limrun construction defers operation and opposite-platform helper modules', async () => {
  const { LimrunRuntime } = await import('../provider-limrun-runtime.ts');
  const runtime = new LimrunRuntime({ apiKey: 'lim_test_key' });

  assert.deepEqual(moduleLoads, {
    androidAppHelpers: 0,
    androidLogcat: 0,
    appleAppResolution: 0,
    appleInstallArtifact: 0,
  });
  await runtime.shutdown();

  const { createLimrunRuntimeDependencies } = await import('./limrun-runtime-dependencies.ts');
  const dependencies = createLimrunRuntimeDependencies();
  const device = {
    platform: 'android' as const,
    id: 'limrun:android:lease-a',
    name: 'Limrun Android',
    kind: 'emulator' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const foregroundAdb = vi.fn(async () => ({
    exitCode: 0,
    stdout: 'mCurrentFocus=Window{1 u0 com.example.app/.MainActivity}',
    stderr: '',
  }));

  assert.deepEqual(
    await dependencies.android.getForegroundApp(
      device,
      foregroundAdb,
      new AbortController().signal,
    ),
    { appId: 'com.example.app', activity: '.MainActivity' },
  );
  assert.equal(moduleLoads.androidAppHelpers, 0);

  const adb = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

  assert.deepEqual(await dependencies.android.listApps(adb, 'all'), [
    { id: 'com.example.app', name: 'Example' },
  ]);
  assert.equal(moduleLoads.androidAppHelpers, 1);
  assert.equal(moduleLoads.androidLogcat, 0);
  assert.equal(moduleLoads.appleAppResolution, 0);
  assert.equal(moduleLoads.appleInstallArtifact, 0);

  assert.equal(await dependencies.android.readLogs(adb, 10), 'log line\n');
  assert.equal(moduleLoads.androidLogcat, 1);
  assert.equal(moduleLoads.appleAppResolution, 0);
  assert.equal(moduleLoads.appleInstallArtifact, 0);

  assert.equal(await dependencies.ios.resolveAppAlias('settings'), 'resolved:settings');
  assert.equal(moduleLoads.appleAppResolution, 1);
  assert.equal(moduleLoads.appleInstallArtifact, 0);

  assert.equal(await dependencies.ios.readBundleAppName('/tmp/Example.app'), 'Example');
  assert.equal(moduleLoads.appleInstallArtifact, 1);
});

test('Limrun appstate forwards an in-flight abort through the provider ADB executor', async () => {
  const { createLimrunRuntimeDependencies } = await import('./limrun-runtime-dependencies.ts');
  const dependencies = createLimrunRuntimeDependencies();
  const device = {
    platform: 'android' as const,
    id: 'limrun:android:lease-abort',
    name: 'Limrun Android',
    kind: 'emulator' as const,
    target: 'mobile' as const,
    booted: true,
  };
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const adb = vi.fn(async (_args: readonly string[], options?: { signal?: AbortSignal }) => {
    observedSignal = options?.signal;
    return await new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener(
        'abort',
        () => reject(options?.signal?.reason ?? new DOMException('Aborted', 'AbortError')),
        { once: true },
      );
    });
  });

  const pending = dependencies.android.getForegroundApp(device, adb, controller.signal);
  await vi.waitFor(() => expect(adb).toHaveBeenCalledOnce());
  controller.abort();

  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  assert.equal(observedSignal, controller.signal);
});

test('host.runAdb carries addressing apart from payload and routes through the host transport', async () => {
  const { createLimrunRuntimeDependencies } = await import('./limrun-runtime-dependencies.ts');
  const {
    androidAdbInvocation,
    androidAdbSerialTarget,
    serializeAndroidAdbInvocation,
    withAndroidHostAdbTransport,
  } = await import('@agent-device/platform-android/mechanics');
  const dependencies = createLimrunRuntimeDependencies();
  const seen: Array<{
    args: string[];
    payload: readonly string[];
    options?: Record<string, unknown>;
  }> = [];

  const result = await withAndroidHostAdbTransport(
    async (invocation, options) => {
      seen.push({
        args: serializeAndroidAdbInvocation(invocation),
        payload: invocation.command,
        ...(options ? { options } : {}),
      });
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    async () =>
      await dependencies.host.runAdb(
        androidAdbInvocation(androidAdbSerialTarget('emulator-5554'), [
          'disconnect',
          'emulator-5554',
        ]),
        {
          allowFailure: true,
          timeoutMs: 10_000,
        },
      ),
  );

  assert.deepEqual(result, { stdout: 'ok', stderr: '', exitCode: 0 });
  assert.deepEqual(seen, [
    {
      args: ['-s', 'emulator-5554', 'disconnect', 'emulator-5554'],
      payload: ['disconnect', 'emulator-5554'],
      options: { allowFailure: true, timeoutMs: 10_000 },
    },
  ]);
});

test('adbError names the failed command with the platform serializer', async () => {
  const { createLimrunRuntimeDependencies } = await import('./limrun-runtime-dependencies.ts');
  const { androidAdbInvocation, androidAdbSerialTarget } =
    await import('@agent-device/platform-android/mechanics');
  const dependencies = createLimrunRuntimeDependencies();

  const failure = await dependencies.android.adbError(
    'Limrun Android ADB command failed',
    { exitCode: 1, stdout: '', stderr: 'device offline' },
    androidAdbInvocation(androidAdbSerialTarget('127.0.0.1:62001'), ['reverse', 'tcp:8081']),
  );

  assert.equal(failure.details?.command, 'adb -s 127.0.0.1:62001 reverse tcp:8081');

  const addressless = await dependencies.android.adbError('ADB failed', {
    exitCode: 1,
    stdout: '',
    stderr: 'no device',
  });
  assert.equal(addressless.details?.command, undefined);
});

test('the adb invocation adapters address through the platform builders', async () => {
  const { createLimrunRuntimeDependencies } = await import('./limrun-runtime-dependencies.ts');
  const {
    androidAdbHostTarget,
    androidAdbInvocation,
    androidAdbSerialTarget,
    serializeAndroidAdbInvocation,
  } = await import('@agent-device/platform-android/mechanics');
  const dependencies = createLimrunRuntimeDependencies();

  const device = dependencies.android.deviceAdbInvocation('127.0.0.1:62001', [
    'shell',
    'pm',
    'list',
    'packages',
  ]);
  assert.deepEqual(
    device,
    androidAdbInvocation(androidAdbSerialTarget('127.0.0.1:62001'), device.command),
  );
  assert.deepEqual(device.command, ['shell', 'pm', 'list', 'packages']);
  assert.deepEqual(serializeAndroidAdbInvocation(device), [
    '-s',
    '127.0.0.1:62001',
    'shell',
    'pm',
    'list',
    'packages',
  ]);

  const host = dependencies.android.hostAdbInvocation(['disconnect', '127.0.0.1:62001']);
  assert.deepEqual(host, androidAdbInvocation(androidAdbHostTarget(), host.command));
  assert.deepEqual(serializeAndroidAdbInvocation(host), ['disconnect', '127.0.0.1:62001']);
});
