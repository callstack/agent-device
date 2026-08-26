import { expect, test, vi } from 'vitest';
import type { DeviceLease, ProviderDeviceRuntime } from '@agent-device/contracts/device';
import type { PlatformRuntimeProviderModule } from '@agent-device/contracts/platform-runtime-operations';
import {
  CLOUD_WEBDRIVER_PROVIDERS,
  createProviderWebDriver,
} from '@agent-device/provider-webdriver';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import type { DeviceInfo } from '@agent-device/kernel/device';
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

test('a stale WebDriver device remains provider-owned and fails admission before local execution', async () => {
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
    const facts = await expectUnsupportedDeploymentAdmission({
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

test('a stale Limrun session is rejected by admission facts before a deployment bind', async () => {
  const registration = createLimrunRuntime({ apiKey: 'limrun-test-key' }, limrunDependencies(), {
    includePlatformModule: true,
  });
  const lease = providerLease('limrun', 'limrun-stale');

  try {
    const allocation = await registration.runtime.leaseLifecycle.allocate?.(lease);
    const device = readAllocatedDevice(allocation);
    await registration.runtime.leaseLifecycle.release?.(lease);

    expect(registration.runtime.ownsDevice(device)).toBe(true);
    const facts = await expectUnsupportedDeploymentAdmission({
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
  } finally {
    await registration.runtime.shutdown();
  }
});

test('an active AWS WebDriver device denies unsupported install from facts before bind or provider execution', async () => {
  const server = await ProviderRegressionServer.start();
  const host = new AwsRemoteAccessHost({ appiumEndpoint: `${server.url}/wd/hub/` });
  const runtime = awsWebDriverRuntime(host);
  const lease = providerLease(CLOUD_WEBDRIVER_PROVIDERS.awsDeviceFarm, 'aws-active-install');

  try {
    await runtime.leaseLifecycle.allocate?.(lease, awsRegressionContext());
    const device = await allocatedDevice(runtime, lease);
    const providerCallsBeforeAdmission = server.calls.length;
    const hostCallsBeforeAdmission = host.calls.length;

    const facts = await expectUnsupportedDeploymentAdmission({
      runtime,
      module: runtime.platformRuntimeModule,
      device,
    });

    expect(facts).toMatchObject({
      device: { providerMode: 'provider-runtime' },
      operations: {
        ensureReady: { available: true },
        deployApp: {
          available: false,
          reason: 'owner-capability-missing',
          hint: expect.stringMatching(/local artifact upload\/install is not implemented/),
        },
        materializeAppSource: { available: false, reason: 'owner-capability-missing' },
        deployMaterializedApp: { available: false, reason: 'owner-capability-missing' },
      },
    });
    expect(server.calls).toHaveLength(providerCallsBeforeAdmission);
    expect(host.calls).toHaveLength(hostCallsBeforeAdmission);
  } finally {
    await runtime.leaseLifecycle.release?.(lease);
    await runtime.shutdown();
    await server.close();
  }
});

async function expectUnsupportedDeploymentAdmission(params: {
  runtime: ProviderDeviceRuntime;
  module: PlatformRuntimeProviderModule;
  device: DeviceInfo;
}) {
  const result = await inspectProviderDeploymentAdmission(params);
  expect(result.response).toMatchObject({
    ok: false,
    error: { code: 'UNSUPPORTED_OPERATION', details: { reason: 'owner-capability-missing' } },
  });
  expect(result.inspectFactCalls).toBe(1);
  expect(result.bindCalls).toBe(0);
  expect(result.localLoadCalls).toBe(0);
  return result.facts;
}

function webDriverRuntime(endpoint: string) {
  const runtimes = createProviderWebDriver({
    clientVersion: 'test',
    runHostCommand: async () => {
      throw new Error('stale WebDriver admission never invokes host commands');
    },
  }).createDefaultRuntimes({
    BROWSERSTACK_USERNAME: 'browser-user',
    BROWSERSTACK_ACCESS_KEY: 'browser-key',
    BROWSERSTACK_WEBDRIVER_ENDPOINT: `${endpoint}/wd/hub/`,
  });
  const runtime = runtimes.find(
    (candidate) => candidate.provider === CLOUD_WEBDRIVER_PROVIDERS.browserStack,
  );
  if (!runtime) throw new Error('Expected BrowserStack WebDriver runtime');
  return runtime;
}

function awsWebDriverRuntime(host: AwsRemoteAccessHost) {
  const runtimes = createProviderWebDriver({
    clientVersion: 'test',
    runHostCommand: host.run,
  }).createDefaultRuntimes({ AWS_REGION: 'us-west-2' });
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
