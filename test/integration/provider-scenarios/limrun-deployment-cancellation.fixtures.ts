import fs from 'node:fs';
import path from 'node:path';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '../../../src/__tests__/test-utils/tmp-dir.ts';

export type LimrunDeploymentAsset = { signedDownloadUrl: string; md5: string };

export const LIMRUN_DEPLOYMENT_ASSET: LimrunDeploymentAsset = {
  signedDownloadUrl: 'https://assets.example.test/app',
  md5: 'asset-md5',
};

export const LIMRUN_IOS_APPS = [
  { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
  { bundleId: 'com.example.ios', name: 'Example', installType: 'User' },
];

export async function bindLimrunDeployment(platform: 'android' | 'ios', signal: AbortSignal) {
  const registration = createLimrunRuntime({ apiKey: 'limrun-test-key' }, limrunDependencies(), {
    includePlatformModule: true,
  });
  const device = await allocatedDevice(registration.runtime, lease(platform));
  const owner = await registration.platformModule.loadRuntime({
    snapshot: {
      captureSurface: async () => ({
        backend: 'xctest' as const,
        producer: 'appium-source' as const,
        nodes: [],
      }),
      presentIosAcquisition: async () => ({
        backend: 'xctest' as const,
        producer: 'appium-source' as const,
        nodes: [],
      }),
    },
  } as unknown as PlatformRuntimeHost);
  const binding = await owner.bind({
    device,
    intent: { kind: 'ordinary' },
    scope: {
      signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  const deployApp = binding.operations.deployApp;
  if (!deployApp) throw new Error('Expected active Limrun deployment operation');
  const appDirectory = mkdtempForTestSync('agent-device-limrun-deployment-cancellation-');
  const appPath = path.join(appDirectory, platform === 'ios' ? 'Demo.ipa' : 'demo.apk');
  fs.writeFileSync(appPath, 'fixture');

  const shutdown = async () => {
    await registration.runtime.shutdown();
    fs.rmSync(appDirectory, { recursive: true, force: true });
  };
  return {
    binding,
    deploy: async () =>
      await deployApp({
        app: platform === 'ios' ? 'com.example.ios' : 'com.example.android',
        appPath,
        replaceExisting: false,
      }),
    shutdown,
    dispose: async () => {
      try {
        await binding[Symbol.asyncDispose]();
      } finally {
        await shutdown();
      }
    },
  };
}

async function allocatedDevice(
  runtime: ReturnType<typeof createLimrunRuntime>,
  deviceLease: DeviceLease,
): Promise<DeviceInfo> {
  const allocation = await runtime.leaseLifecycle.allocate?.(deviceLease);
  const device = allocation?.device;
  if (!device || typeof device !== 'object') throw new Error('Expected allocated Limrun device');
  return device as DeviceInfo;
}

function lease(platform: 'android' | 'ios'): DeviceLease {
  return {
    leaseId: `limrun-cancel-${platform}`,
    tenantId: 'team-a',
    runId: 'run-a',
    backend: platform === 'ios' ? 'ios-instance' : 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

function limrunDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: 'test',
    android: {
      createInteractor: () => ({}) as never,
      createPortReverse: async () => ({
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
      }),
      inferAppName: async () => 'Example',
      listApps: async () => [],
      getForegroundApp: async () => undefined,
      getKeyboardState: async () => ({ visible: false, inputOwner: 'unknown' }),
      dismissKeyboard: async () => ({
        visible: false,
        inputOwner: 'unknown',
        attempts: 0,
        wasVisible: false,
        dismissed: false,
      }),
      readLogs: async () => '',
      adbError: async (message) => new Error(message) as never,
    },
    host: {
      runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      archiveDirectory: async () => {},
    },
    ios: {
      resolveAppAlias: async (app) => app,
      readBundleAppName: async () => undefined,
    },
  };
}
