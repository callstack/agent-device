import { withMethodScope } from '@agent-device/kernel/scoped-provider';
import { withAppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import { createLimrunAppleToolProvider } from '../../../src/core/interactors/limrun-ios-tools.ts';
import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import {
  limrunTestDependencies,
  createTestLimrunIosRunner,
} from '../../../src/platform-runtime-gateway.fixtures.ts';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { formatCliOutput } from '@agent-device/command-output';
import { assertRpcOk } from './assertions.ts';
import { createProviderScenarioHarness } from './harness.ts';

const limrunApiState = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({
    metadata: { id: 'limrun-snapshot-test-instance' },
    status: { apiUrl: 'https://limrun.example', token: 'limrun-test-token' },
  })),
  deleteInstance: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  simctl: vi.fn(),
  runnerCommand: vi.fn(async (_command: Record<string, unknown>) => ({
    nodes: [
      {
        index: 0,
        type: 'Application',
        label: 'App',
        rect: { x: 0, y: 0, width: 320, height: 240 },
      },
      {
        index: 1,
        parentIndex: 0,
        type: 'Button',
        label: 'Continue',
        rect: { x: 24, y: 96, width: 160, height: 48 },
        enabled: true,
        hittable: true,
      },
    ],
    truncated: false,
    keyboard: { kind: 'absent' },
  })),
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
      disconnect: limrunApiState.disconnect,
      simctl: limrunApiState.simctl,
    })),
  };
});

beforeEach(() => {
  limrunApiState.createInstance.mockClear();
  limrunApiState.deleteInstance.mockClear();
  limrunApiState.disconnect.mockClear();
  limrunApiState.runnerCommand.mockClear();
  limrunApiState.simctl.mockClear();
});

test('Limrun XCTest snapshots reach the daemon and public output with runner metadata', async () => {
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
    assert.equal(limrunApiState.createInstance.mock.calls.length, 1);
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
    assertRpcOk(await daemon.callCommand('open', ['com.example.app'], flags, { meta }));
    assert.deepEqual(
      limrunApiState.simctl.mock.calls.filter(([args]) => args[0] === 'launch'),
      [[['launch', 'booted', 'com.example.app'], undefined]],
    );
    const response = await daemon.callCommand('snapshot', [], flags, { meta });
    const result = assertRpcOk<CaptureSnapshotResult>(response);

    assert.equal(
      limrunApiState.runnerCommand.mock.calls.filter(([command]) => command.command === 'snapshot')
        .length,
      1,
    );
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
    assert.equal(result.truncated, false);
    assert.deepEqual(result.keyboard, { kind: 'absent' });
    assert.equal(result.warnings, undefined);
    const cliOutput = await formatCliOutput({
      name: 'snapshot',
      env: process.env,
      stderrIsTTY: false,
      input: {},
      result,
    });
    assert.ok(cliOutput, 'snapshot renders CLI output');
    assert.equal(JSON.stringify(cliOutput.jsonData).includes('"truncated":false'), true);
    assertRpcOk(await daemon.callCommand('press', ['label=Continue'], flags, { meta }));
    assert.ok(
      limrunApiState.runnerCommand.mock.calls.some(
        ([command]) =>
          command.command === 'tap' &&
          command.appBundleId === 'com.example.app' &&
          command.x === 104 &&
          command.y === 120,
      ),
    );
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
        const runner = await createTestLimrunIosRunner(session.device, (command) =>
          limrunApiState.runnerCommand(command),
        );
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
