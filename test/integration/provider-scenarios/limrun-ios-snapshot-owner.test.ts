import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { snapshotCliOutput } from '../../../src/commands/capture/output.ts';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';

const limrunApiState = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({
    metadata: { id: 'limrun-snapshot-test-instance' },
    status: { apiUrl: 'https://limrun.example', token: 'limrun-test-token' },
  })),
  deleteInstance: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  elementTree: vi.fn(async () =>
    JSON.stringify({
      elementType: 'Application',
      label: 'App',
      frame: { x: 0, y: 0, width: 320, height: 240 },
      children: [
        {
          elementType: 'Button',
          label: 'Continue',
          frame: { x: 24, y: 96, width: 160, height: 48 },
          enabled: true,
          hittable: true,
        },
      ],
    }),
  ),
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = {
      create: limrunApiState.createInstance,
      list: vi.fn(),
      delete: limrunApiState.deleteInstance,
    };

    readonly androidInstances = {
      create: vi.fn(),
      list: vi.fn(),
      delete: vi.fn(),
    };

    readonly assets = { getOrUpload: vi.fn(), list: vi.fn() };
  },
}));

vi.mock('@limrun/api/ios-client', () => ({
  createInstanceClient: vi.fn(async () => ({
    deviceInfo: { screenWidth: 320, screenHeight: 240 },
    disconnect: limrunApiState.disconnect,
    elementTree: limrunApiState.elementTree,
  })),
}));

vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(async () => ({})) };
});

vi.mock('../../../src/daemon/ios-app-session-hint.ts', () => ({
  buildIosOpenCommandHint: vi.fn(async () => undefined),
}));

beforeEach(() => {
  limrunApiState.createInstance.mockClear();
  limrunApiState.deleteInstance.mockClear();
  limrunApiState.disconnect.mockClear();
  limrunApiState.elementTree.mockClear();
});

test('Limrun iOS acquisition reaches one host presenter and the public snapshot output', async () => {
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
      snapshotInteractiveOnly: true,
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
    const response = await daemon.callCommand('snapshot', [], flags, { meta });
    const result = assertRpcOk<CaptureSnapshotResult>(response);

    assert.equal(limrunApiState.elementTree.mock.calls.length, 1);
    assert.deepEqual(
      result.nodes?.map((node) => [node.type, node.label]),
      [
        ['Application', 'App'],
        ['Button', 'Continue'],
      ],
    );
    assert.equal(
      result.nodes?.every((node) => typeof node.ref === 'string'),
      true,
    );
    assert.equal(result.truncated, undefined);
    assert.deepEqual(result.warnings, [
      'iOS snapshot acquisition does not provide hittability evidence; regular snapshots omit unverified hittability while raw snapshots preserve supplied facts.',
      'iOS snapshot acquisition does not report hierarchy completeness; provider-side depth or child limits may omit nodes.',
      'iOS snapshot acquisition does not expose truncation metadata; tree completeness is not independently verified.',
    ]);

    const cliOutput = await snapshotCliOutput({ result });
    assert.equal(JSON.stringify(cliOutput.jsonData).includes('"truncated"'), false);
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
      resolveAppAlias: async (app) => app,
      readBundleAppName: async () => undefined,
    },
  };
}
