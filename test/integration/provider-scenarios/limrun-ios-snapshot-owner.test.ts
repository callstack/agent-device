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
import fs from 'node:fs';

const limrunApiState = vi.hoisted(() => ({
  createInstance: vi.fn(async () => ({
    metadata: { id: 'limrun-snapshot-test-instance' },
    status: { apiUrl: 'https://limrun.example', token: 'limrun-test-token' },
  })),
  deleteInstance: vi.fn(async () => undefined),
  disconnect: vi.fn(),
  simctl: vi.fn(),
  /** The describe refusal the runner answers instead of a tree, when set. */
  bridgeRefusal: undefined as string | undefined,
  runnerCommand: vi.fn(async (command: Record<string, unknown>) => runnerAnswer(command)),
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

    readonly assets = { list: vi.fn() };
  },
}));

// The fake runner stands in for the registered session a real Limrun runner start leaves behind.
vi.mock('@agent-device/apple-runner', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/apple-runner')>()),
  readRunnerSessionLiveness: () => ({ sessionId: 'limrun-runner-session', liveness: 'ready' }),
}));

vi.mock('@limrun/api/ios-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@limrun/api/ios-client')>();
  limrunApiState.simctl.mockImplementation((args: string[]) => {
    const execution = new actual.SimctlExecution(() => {});
    vi.spyOn(execution, 'wait').mockResolvedValue({
      code: 0,
      stdout:
        args[0] === 'list'
          ? JSON.stringify({ devices: { ios: [{ udid: 'remote-udid', state: 'Booted' }] } })
          : '',
      stderr: '',
    });
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
  limrunApiState.bridgeRefusal = undefined;
  limrunApiState.simctl.mockClear();
});

test('Limrun snapshots read the runner-served bridge and reach the daemon and public output', async () => {
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

    const sentCommands = limrunApiState.runnerCommand.mock.calls.map(([command]) => command);
    assert.equal(sentCommands.filter((command) => command.command === 'snapshot').length, 0);
    assert.deepEqual(
      sentCommands
        .filter((command) => command.command === 'snapshotBridge')
        .map((command) => (command.snapshotBridge as { verb: string }).verb),
      ['target', 'describe'],
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

test('a Limrun capture the bridge cannot serve falls back to the XCTest snapshot and says so', async () => {
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
  limrunApiState.bridgeRefusal = 'bridge-read-abandoned';

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
    assertRpcOk(await daemon.callCommand('open', ['com.example.app'], flags, { meta }));
    const result = assertRpcOk<CaptureSnapshotResult>(
      await daemon.callCommand('snapshot', [], flags, { meta }),
    );

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
    assert.deepEqual(result.keyboard, { kind: 'absent' });
    assert.deepEqual(result.warnings, [
      'Simulator AX snapshot unavailable (bridge-read-abandoned); used XCTest for this app generation.',
    ]);
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
        const lifetime = new AbortController();
        return {
          ...runner,
          createInteractor: (context) =>
            withMethodScope(runner.createInteractor(context), (task) =>
              withAppleToolProvider(
                createLimrunAppleToolProvider(session, lifetime.signal, context?.signal),
                task,
              ),
            ),
        };
      },
    },
  };
}

/** The XCTest runner's answers: system surface hosts in the background, and the bridge tree. */
function runnerAnswer(command: Record<string, unknown>): Record<string, unknown> {
  if (command.command === 'appState') return { applicationState: 'notRunning' };
  if (command.command === 'snapshotBridge') return bridgeAnswer(command);
  if (command.command === 'querySelector' && command.authorizedTarget) {
    const target = command.authorizedTarget as {
      type?: string;
      label?: string;
      rect?: { x?: number; y?: number; width?: number; height?: number };
    };
    return {
      pressReadiness:
        target.type === 'Button' &&
        target.label === 'Continue' &&
        target.rect?.x === 24 &&
        target.rect?.y === 96 &&
        target.rect?.width === 160 &&
        target.rect?.height === 48
          ? 'ready'
          : 'missing',
      pressReadinessAppBundleId: 'com.example.app',
    };
  }
  return {
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
  };
}

/** The bridge protocol both readers speak, as the shared wire vocabulary pins it. */
const BRIDGE_WIRE = JSON.parse(
  fs.readFileSync(
    new URL(
      '../../../packages/platform-apple/src/snapshot-source/fixtures/wire-vocabulary.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as { protocolVersion: number; sourceVersion: string };

function bridgeAnswer(command: Record<string, unknown>): Record<string, unknown> {
  const request = command.snapshotBridge as Record<string, unknown>;
  const identity = { pid: 41, processStartTime: '1700000000.000001' };
  const common = {
    protocolVersion: BRIDGE_WIRE.protocolVersion,
    sourceVersion: BRIDGE_WIRE.sourceVersion,
    requestId: request.requestId,
  };
  if (request.verb === 'target') {
    return { snapshotBridgeEnvelope: JSON.stringify({ ...common, ok: true, ...identity }) };
  }
  if (limrunApiState.bridgeRefusal) {
    return {
      snapshotBridgeEnvelope: JSON.stringify({
        ...common,
        ok: false,
        pid: request.expectedPid,
        generation: request.generation,
        error_kind: 'application_not_responding',
        error_code: limrunApiState.bridgeRefusal,
      }),
    };
  }
  const element = (type: string, label: string, frame: Record<string, number>, children = []) => ({
    XC_kAXXCAttributeElementType: type,
    XC_kAXXCAttributeLabel: label,
    XC_kAXXCAttributeFrame: frame,
    XC_kAXXCAttributeChildren: children,
  });
  return {
    snapshotBridgeEnvelope: JSON.stringify({
      ...common,
      ok: true,
      pid: identity.pid,
      generation: request.generation,
      truncated: false,
      automationEnabled: true,
      recovery: {
        requests: 1,
        rejected: 0,
        continuations: 0,
        acceptedLevels: Number(request.maxDepth) + 1,
      },
      tree: {
        ...element('Application', 'App', { X: 0, Y: 0, Width: 320, Height: 240 }),
        XC_kAXXCAttributeChildren: [
          element('Button', 'Continue', { X: 24, Y: 96, Width: 160, Height: 48 }),
        ],
      },
    }),
  };
}
