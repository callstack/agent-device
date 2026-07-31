import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const moduleLoads = vi.hoisted(() => ({
  androidAppHelpers: 0,
  androidLogcat: 0,
  appleAppResolution: 0,
  appleInstallArtifact: 0,
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {},
}));

vi.mock('../platforms/android/app-helpers.ts', () => {
  moduleLoads.androidAppHelpers += 1;
  return {
    getAndroidAppStateWithAdb: vi.fn(async () => ({
      package: 'com.example.app',
      activity: '.MainActivity',
    })),
    listAndroidAppsWithAdb: vi.fn(async () => [{ package: 'com.example.app', name: 'Example' }]),
  };
});

vi.mock('../platforms/android/logcat.ts', () => {
  moduleLoads.androidLogcat += 1;
  return {
    captureAndroidLogcatWithAdb: vi.fn(async () => 'log line\n'),
  };
});

vi.mock('../platforms/apple/core/app-resolution.ts', () => {
  moduleLoads.appleAppResolution += 1;
  return {
    resolveIosAppAlias: vi.fn((app: string) => `resolved:${app}`),
  };
});

vi.mock('../platforms/apple/core/install-artifact.ts', () => {
  moduleLoads.appleInstallArtifact += 1;
  return {
    readIosBundleInfo: vi.fn(async () => ({ appName: 'Example' })),
  };
});

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
