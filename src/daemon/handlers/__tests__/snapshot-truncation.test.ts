import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { captureSnapshotWithInteractor } from '../../snapshot-interactor-capture.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../snapshot.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { createLimrunRuntime, type LimrunRuntimeDependencies } from '@agent-device/provider-limrun';
import { snapshotCliOutput } from '../../../commands/capture/output.ts';
import { makeSession, makeSessionStore } from './snapshot-handler-fixture.ts';
import {
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../__tests__/snapshot-runtime-fixture.ts';

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
          elementType: 'Table',
          label: 'Settings',
          frame: { x: 0, y: 0, width: 320, height: 240 },
          children: [
            {
              elementType: 'Cell',
              label: 'Target',
              frame: { x: 16, y: 40, width: 288, height: 52 },
              children: [
                {
                  elementType: 'Button',
                  label: 'Save',
                  frame: { x: 32, y: 48, width: 100, height: 36 },
                  enabled: true,
                  hittable: true,
                },
                {
                  elementType: 'StaticText',
                  label: 'Save',
                  frame: { x: 32, y: 48, width: 100, height: 36 },
                },
              ],
            },
          ],
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

    readonly assets = {
      getOrUpload: vi.fn(),
      list: vi.fn(),
    };
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

vi.mock('../../ios-app-session-hint.ts', () => ({
  buildIosOpenCommandHint: vi.fn(async () => undefined),
}));

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  limrunApiState.createInstance.mockClear();
  limrunApiState.deleteInstance.mockClear();
  limrunApiState.disconnect.mockClear();
  limrunApiState.elementTree.mockClear();
});

test('Limrun unknown truncation stays omitted through daemon and public output', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'limrun-ios-unknown-truncation';
  let providerNodes: Array<[string | undefined, string | undefined]> | undefined;
  const limrunRuntime = createLimrunRuntime(
    { apiKey: 'limrun-test-key' },
    limrunRuntimeDependencies(),
  );

  try {
    const allocation = await limrunRuntime.leaseLifecycle.allocate?.(limrunLease());
    const limrunDevice = allocation?.device;
    if (!limrunDevice || typeof limrunDevice !== 'object') {
      throw new Error('Expected Limrun device allocation');
    }
    const device = limrunDevice as DeviceInfo;
    sessionStore.set(sessionName, makeSession(sessionName, device));
    setActiveProviderDeviceRuntimes([limrunRuntime]);

    const runtime = snapshotRuntimeFixture(undefined, {
      captureSnapshot: async (captureDevice, input, signal) => {
        const result = await captureSnapshotWithInteractor({
          device: captureDevice,
          runnerContext: {
            ...input.execution,
            appBundleId: input.options?.appBundleId,
            signal,
          },
          options: { ...input.options, signal },
        });
        providerNodes = result.nodes?.map((node) => [node.type, node.label]);
        return result;
      },
    });
    const response = await handleProductionSnapshotCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'snapshot',
        positionals: [],
        flags: { snapshotInteractiveOnly: true },
      },
      sessionName,
      logPath: '/tmp/daemon.log',
      sessionStore,
      inspectFacts: runtime.inspectFacts,
      bindDevice: runtime.bindDevice,
      platformResourceCleanup,
    });

    expect(response?.ok).toBe(true);
    if (!response?.ok) return;
    const responseData = response.data as unknown as CaptureSnapshotResult;
    expect(limrunApiState.elementTree).toHaveBeenCalledOnce();
    expect(providerNodes).toEqual([
      ['Application', 'App'],
      ['Table', 'Settings'],
      ['Cell', 'Target'],
      ['Button', 'Save'],
      ['StaticText', 'Save'],
    ]);
    expect(responseData.nodes?.map((node) => [node.type, node.label])).toEqual(providerNodes);
    expect(responseData).not.toHaveProperty('truncated');

    const cliOutput = await snapshotCliOutput({
      result: responseData,
    });
    expect(cliOutput.jsonData).not.toHaveProperty('truncated');
  } finally {
    await limrunRuntime.shutdown();
  }
});

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

function limrunLease(): DeviceLease {
  return {
    leaseId: 'lease-a',
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'ios-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}
