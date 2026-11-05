import assert from 'node:assert/strict';
import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import { withAppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import { createLimrunAppleToolProvider } from '../../../src/core/interactors/limrun-ios-tools.ts';
import { beforeEach, test, vi } from 'vitest';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import {
  limrunTestDependencies,
  createTestLimrunIosRunner,
} from '../../../src/platform-runtime-gateway.fixtures.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { assertRpcError, assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';

const BUNDLE_ID = 'com.apple.Preferences';

const limrunApiState = vi.hoisted(() => ({
  listApps: vi.fn(),
  simctl: vi.fn(),
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

vi.mock('@limrun/api/ios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@limrun/api/ios-client')>();
  limrunApiState.simctl.mockImplementation((args: string[]) => {
    const execution = new actual.SimctlExecution(() => {});
    if (args[0] === 'list')
      execution._handleStdout(
        Buffer.from(
          JSON.stringify({ devices: { ios: [{ udid: 'remote-udid', state: 'Booted' }] } }),
        ),
      );
    execution._handleExit(0);
    return execution;
  });
  return {
    createInstanceClient: vi.fn(async () => ({
      deviceInfo: { udid: 'remote-udid', screenWidth: 320, screenHeight: 240 },
      disconnect: vi.fn(),
      simctl: limrunApiState.simctl,
      listApps: limrunApiState.listApps,
    })),
  };
});

beforeEach(() => {
  limrunApiState.listApps.mockReset();
  limrunApiState.simctl.mockClear();
});

test('Limrun iOS appstate refuses a gone instance', async () => {
  const target = BUNDLE_ID;
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
    assertRpcOk(await daemon.callCommand('open', [target], flags, { meta }));
    assert.ok(
      limrunApiState.simctl.mock.calls.some(
        ([args]) => args[0] === (target === BUNDLE_ID ? 'launch' : 'openurl'),
      ),
    );

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
    ios: {
      ...limrunTestDependencies.ios,
      createRunner: async (session) => {
        const runner = await createTestLimrunIosRunner(session.device);
        const lifetime = new AbortController().signal;
        return {
          ...runner,
          createInteractor: (context) =>
            withMethodScope(runner.createInteractor(context), (task) =>
              withAppleToolProvider(
                createLimrunAppleToolProvider(session, lifetime, context?.signal),
                task,
              ),
            ),
        };
      },
    },
  };
}
