import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { limrunTestDependencies } from '../../../src/platform-runtime-gateway.fixtures.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';

const BUNDLE_ID = 'com.apple.Preferences';

const limrunApiState = vi.hoisted(() => ({
  listApps: vi.fn(),
  launchApp: vi.fn(async () => undefined),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: vi.fn(async () => ({
        metadata: { id: 'limrun-appstate-test-instance' },
        status: { apiUrl: 'https://limrun.example', token: 'limrun-test-token' },
      })),
      list: vi.fn(),
      delete: vi.fn(async () => undefined),
    };

    readonly androidInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };

    readonly assets = { getOrUpload: vi.fn(), list: vi.fn() };
  },
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    deviceInfo: { screenWidth: 320, screenHeight: 240 },
    disconnect: vi.fn(),
    launchApp: limrunApiState.launchApp,
    listApps: limrunApiState.listApps,
  })),
}));

beforeEach(() => {
  limrunApiState.listApps.mockReset();
  limrunApiState.launchApp.mockClear();
});

test('Limrun iOS appstate stops answering from the session once the instance is gone', async () => {
  limrunApiState.listApps.mockResolvedValue([]);
  const registration = createLimrunRuntime(
    { apiKey: 'limrun-test-key' },
    limrunRuntimeDependencies(),
    { includePlatformModule: true },
  );
  const runtime = registration.runtime;
  const providers = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providers,
    deviceInventorySource: providers.deviceInventorySource!,
    platformRuntime: {
      providerRuntimes: [runtime],
      providerModules: [{ runtime, module: registration.platformModule }],
    },
  });

  try {
    const lease = await allocateLease(daemon);
    const flags = {
      platform: 'ios' as const,
      tenant: 'team-a',
      runId: 'run-a',
      leaseId: lease.leaseId,
      leaseProvider: 'limrun',
    };
    const meta = {
      tenantId: 'team-a',
      runId: 'run-a',
      leaseId: lease.leaseId,
      leaseBackend: 'ios-instance' as const,
      leaseProvider: 'limrun',
      deviceKey: 'ios-a',
      clientId: 'client-a',
    };
    assertRpcOk(await daemon.callCommand('open', [BUNDLE_ID], flags, { meta }));
    assert.equal(limrunApiState.launchApp.mock.calls.length, 1);

    const live = assertRpcOk<{ appBundleId?: string; source?: string }>(
      await daemon.callCommand('appstate', [], flags, { meta }),
    );
    assert.equal(live.appBundleId, BUNDLE_ID);
    assert.equal(live.source, 'session');

    limrunApiState.listApps.mockRejectedValue(new Error('instance not found'));
    const gone = await daemon.callCommand('appstate', [], flags, { meta });

    const refusal = assertRpcError(gone, 500, 'COMMAND_FAILED', /Could not confirm/);
    assert.equal((refusal.details as { reason?: string }).reason, 'limrun_instance_unreachable');
  } finally {
    await daemon.close();
    await runtime.shutdown();
  }
});

async function allocateLease(
  daemon: Awaited<ReturnType<typeof createProviderScenarioHarness>>,
): Promise<DeviceLease> {
  const response = await daemon.callCommand(
    'lease_allocate',
    [],
    { platform: 'ios', tenant: 'team-a', runId: 'run-a', leaseProvider: 'limrun' },
    {
      meta: {
        tenantId: 'team-a',
        runId: 'run-a',
        leaseBackend: 'ios-instance',
        leaseProvider: 'limrun',
        deviceKey: 'ios-a',
        clientId: 'client-a',
      },
    },
  );
  return assertRpcOk<{ lease: DeviceLease }>(response).lease;
}

function limrunRuntimeDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: 'test-version',
    android: {} as LimrunRuntimeDependencies['android'],
    host: {} as LimrunRuntimeDependencies['host'],
    ios: limrunTestDependencies.ios,
  };
}
