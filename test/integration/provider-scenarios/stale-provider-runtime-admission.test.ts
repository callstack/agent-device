import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createBundledCloudWebDriverRuntimes } from '@agent-device/provider-webdriver';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { limrunTestDependencies } from '../../../src/platform-runtime-gateway.fixtures.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';
import {
  CloudWebDriverTestServer,
  cloudWebDriverTestJson,
  startCloudWebDriverTestServer,
  type CloudWebDriverHttpCall,
} from './cloud-webdriver-test-server.ts';
import {
  AwsRemoteAccessHost,
  ProviderRegressionServer,
  awsRegressionContext,
} from './cloud-webdriver-regression-fixtures.ts';
import { inspectProviderDeploymentAdmission } from './stale-provider-runtime-admission.fixtures.ts';
import { CLOUD_WEBDRIVER_PROVIDERS } from '@agent-device/provider-webdriver/providers';

const limrunState = vi.hoisted(() => ({
  androidCreate: vi.fn(async () => ({
    metadata: { id: 'limrun-instance-a' },
    status: {
      token: 'instance-token',
      apiUrl: 'https://limrun.example.test',
      adbWebSocketUrl: 'wss://limrun.example.test/adb',
    },
  })),
  androidDelete: vi.fn(async () => undefined),
  disconnect: vi.fn(),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly androidInstances = {
      create: limrunState.androidCreate,
      list: vi.fn(),
      delete: limrunState.androidDelete,
    };
    readonly iosInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };
    readonly assets = { getOrUpload: vi.fn() };
  },
  NotFoundError: class NotFoundError extends Error {},
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    disconnect: limrunState.disconnect,
    setText: vi.fn(),
    sendAsset: vi.fn(),
    startAdbTunnel: vi.fn(async () => ({
      address: { address: '127.0.0.1', port: 62_001 },
      close: vi.fn(),
    })),
  })),
}));

test('a released WebDriver device remains provider-owned with deployment unavailable', async () => {
  const server = await startCloudWebDriverTestServer(new StaleWebDriverServer());
  const runtime = webDriverRuntime(server.url);
  const lease = providerLease(CLOUD_WEBDRIVER_PROVIDERS.browserStack, 'webdriver-stale');

  try {
    const allocate = runtime.leaseLifecycle.allocate;
    if (!allocate) throw new Error('Cloud WebDriver runtime must allocate leases');
    await allocate(lease, {
      flags: {
        platform: 'android',
        device: 'Test Android',
        providerOsVersion: '14',
        providerApp: 'bs://example-app',
      },
    });
    const device = await allocatedDevice(runtime, lease);
    await runtime.leaseLifecycle.release?.(lease);

    expect(runtime.ownsDevice(device)).toBe(true);
    const facts = await inspectProviderDeploymentAdmission({
      runtime,
      module: runtime.platformRuntimeModule,
      device,
    });
    expect(facts).toMatchObject({
      device: { providerMode: 'provider-runtime' },
      operations: {
        ensureReady: { available: false, reason: 'owner-capability-missing' },
        deployApp: { available: false, reason: 'owner-capability-missing' },
      },
    });
  } finally {
    await runtime.shutdown();
    await server.close();
  }
});

test('a released Limrun session exposes unavailable deployment facts before binding', async () => {
  const registration = createLimrunRuntime({ apiKey: 'limrun-test-key' }, limrunDependencies(), {
    includePlatformModule: true,
  });
  const lease = providerLease('limrun', 'limrun-stale');

  try {
    const allocation = await registration.runtime.leaseLifecycle.allocate?.(lease);
    const device = readAllocatedDevice(allocation);
    expect(limrunState.androidCreate).toHaveBeenCalledTimes(1);
    await registration.runtime.leaseLifecycle.release?.(lease);
    expect(limrunState.disconnect).toHaveBeenCalled();

    expect(registration.runtime.ownsDevice(device)).toBe(true);
    const createCallsBeforeAdmission = limrunState.androidCreate.mock.calls.length;
    const facts = await inspectProviderDeploymentAdmission({
      runtime: registration.runtime,
      module: registration.platformModule,
      device,
    });
    expect(facts).toMatchObject({
      device: { providerMode: 'provider-runtime' },
      operations: {
        ensureReady: { available: false, reason: 'owner-capability-missing' },
        deployApp: { available: false, reason: 'owner-capability-missing' },
      },
    });
    expect(limrunState.androidCreate).toHaveBeenCalledTimes(createCallsBeforeAdmission);
  } finally {
    await registration.runtime.shutdown();
  }
});

test('an active AWS WebDriver device denies unsupported install from facts before bind or provider execution', async () => {
  const server = await ProviderRegressionServer.start();
  const host = new AwsRemoteAccessHost({ appiumEndpoint: `${server.url}/wd/hub/` });
  const runtime = awsWebDriverRuntime(host);
  const provider = runtime.platformRuntimeModule;
  if (!provider) throw new Error('AWS WebDriver runtime requires its platform runtime module');
  let bindCalls = 0;
  const countedProvider = Object.freeze({
    ...provider,
    loadRuntime: async (...args: Parameters<typeof provider.loadRuntime>) => {
      const owner = await provider.loadRuntime(...args);
      return Object.freeze({
        ...owner,
        bind: async (request: Parameters<typeof owner.bind>[0]) => {
          bindCalls += 1;
          return await owner.bind(request);
        },
      });
    },
  });
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventorySource: providers.deviceInventorySource!,
    platformRuntime: {
      providerRuntimes: [runtime],
      providerModules: [{ runtime, module: countedProvider }],
    },
  });
  const leaseId = 'a'.repeat(32);
  const flags = {
    ...awsRegressionContext().flags,
    tenant: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
  };
  const meta = {
    tenantId: 'team-a',
    runId: 'run-a',
    leaseId,
    leaseBackend: 'android-instance' as const,
    leaseProvider: CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
    deviceKey: 'provider-device-regression',
    clientId: 'client-a',
  };
  let lease: DeviceLease | undefined;

  try {
    lease = assertRpcOk<{ lease: DeviceLease }>(
      await daemon.callCommand('lease_allocate', [], flags, { meta }),
    ).lease;
    const device = await allocatedDevice(runtime, lease);
    const tempDir = mkdtempForTestSync('agent-device-provider-install-admission-');
    const appPath = path.join(tempDir, 'demo.apk');
    fs.writeFileSync(appPath, 'fake apk');
    const providerCallsBeforeAdmission = server.calls.length;
    const hostCallsBeforeAdmission = host.calls.length;
    const bindCallsBeforeAdmission = bindCalls;
    const response = await daemon.callCommand(
      'install',
      [appPath],
      { ...flags, serial: device.id },
      { meta },
    );
    const error = assertRpcError(
      response,
      500,
      'UNSUPPORTED_OPERATION',
      /not supported on this device/,
    );
    assert.equal(
      (error.details as Record<string, unknown> | undefined)?.reason,
      'owner-capability-missing',
    );
    expect(bindCalls).toBe(bindCallsBeforeAdmission);
    expect(server.calls).toHaveLength(providerCallsBeforeAdmission);
    expect(host.calls).toHaveLength(hostCallsBeforeAdmission);
  } finally {
    try {
      if (lease) await daemon.callCommand('lease_release', [], flags, { meta });
    } finally {
      try {
        await daemon.close();
      } finally {
        try {
          await runtime.shutdown();
        } finally {
          await server.close();
        }
      }
    }
  }
});

function webDriverRuntime(endpoint: string) {
  const runtimes = createBundledCloudWebDriverRuntimes({
    env: {
      BROWSERSTACK_USERNAME: 'browser-user',
      BROWSERSTACK_ACCESS_KEY: 'browser-key',
      BROWSERSTACK_WEBDRIVER_ENDPOINT: `${endpoint}/wd/hub/`,
    },
    clientVersion: 'test',
    runHostCommand: async () => {
      throw new Error('stale WebDriver admission never invokes host commands');
    },
  });
  const runtime = runtimes.find(
    (candidate) => candidate.provider === CLOUD_WEBDRIVER_PROVIDERS.browserStack,
  );
  if (!runtime) throw new Error('Expected BrowserStack WebDriver runtime');
  return runtime;
}

function awsWebDriverRuntime(host: AwsRemoteAccessHost) {
  const runtimes = createBundledCloudWebDriverRuntimes({
    env: { AWS_REGION: 'us-west-2' },
    clientVersion: 'test',
    runHostCommand: host.run,
  });
  const runtime = runtimes.find(
    (candidate) => candidate.provider === CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm,
  );
  if (!runtime) throw new Error('Expected AWS Device Farm WebDriver runtime');
  return runtime;
}

async function allocatedDevice(
  runtime: ReturnType<typeof webDriverRuntime>,
  lease: DeviceLease,
): Promise<DeviceInfo> {
  const devices = await runtime.deviceInventoryProvider({
    leaseProvider: lease.leaseProvider,
    leaseId: lease.leaseId,
  });
  const device = devices?.[0];
  if (!device) throw new Error('Expected the allocated WebDriver device');
  return device;
}

function readAllocatedDevice(allocation: Record<string, unknown> | undefined): DeviceInfo {
  const device = allocation?.device;
  if (!device || typeof device !== 'object')
    throw new Error('Expected the allocated Limrun device');
  return device as DeviceInfo;
}

function providerLease(provider: string, leaseId: string): DeviceLease {
  return {
    leaseId,
    tenantId: 'team-a',
    runId: 'run-a',
    clientId: 'client-a',
    leaseProvider: provider,
    backend: 'android-instance',
    deviceKey: `${provider}:device-a`,
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
        list: async () => [],
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
      forceStopApp: async () => {},
      deviceAdbInvocation: (serial: string, command: readonly string[]) => ({
        target: { selector: { kind: 'serial', serial }, server: { kind: 'ambient' } },
        command,
      }),
      hostAdbInvocation: (command: readonly string[]) => ({
        target: { selector: { kind: 'unspecified' }, server: { kind: 'ambient' } },
        command,
      }),
      adbError: async (message) => new Error(message) as never,
    },
    host: {
      runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      downloadFile: async () => undefined,
      archiveDirectory: async () => {},
    },
    ios: limrunTestDependencies.ios,
  };
}

class StaleWebDriverServer extends CloudWebDriverTestServer {
  protected respond(call: CloudWebDriverHttpCall) {
    if (call.method === 'POST' && call.path === '/wd/hub/session') {
      return cloudWebDriverTestJson({
        value: { sessionId: 'webdriver-session-a', capabilities: { platformName: 'Android' } },
      });
    }
    if (call.method === 'DELETE' && call.path === '/wd/hub/session/webdriver-session-a') {
      return cloudWebDriverTestJson({ value: null });
    }
    return cloudWebDriverTestJson(
      { value: { message: `Unexpected ${call.method} ${call.path}` } },
      500,
    );
  }
}
