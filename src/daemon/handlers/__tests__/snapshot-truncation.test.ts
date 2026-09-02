import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { captureSnapshotWithInteractor } from '../snapshot-interactor-capture.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../snapshot.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import { snapshotCliOutput } from '../../../commands/capture/output.ts';
import { createLimrunIosInteractor } from '../../../../packages/provider-limrun/src/ios.ts';
import {
  createLimrunSnapshotSession,
  limrunSnapshotTree,
} from '../../../../packages/provider-limrun/src/ios-snapshot-adapter.fixtures.ts';
import {
  makeProviderRuntimeOwning,
  makeSession,
  makeSessionStore,
} from './snapshot-handler-fixture.ts';
import {
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../__tests__/snapshot-runtime-fixture.ts';

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
});

test('Limrun unknown truncation stays omitted through daemon and public output', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'limrun-ios-unknown-truncation';
  const limrunDevice = {
    platform: 'apple',
    appleOs: 'ios',
    id: 'limrun:ios:lease-a',
    name: 'Limrun iOS',
    kind: 'simulator',
    target: 'mobile',
    booted: true,
  } as const;
  const limrunSession = createLimrunSnapshotSession(limrunSnapshotTree());
  const elementTree = vi.spyOn(limrunSession.client, 'elementTree');
  const limrunInteractor = createLimrunIosInteractor(limrunSession);
  let providerNodes: Array<[string | undefined, string | undefined]> | undefined;
  sessionStore.set(sessionName, makeSession(sessionName, limrunDevice));
  setActiveProviderDeviceRuntimes([
    {
      ...makeProviderRuntimeOwning(limrunDevice, 'limrun'),
      getInteractor: (device) => (device.id === limrunDevice.id ? limrunInteractor : undefined),
    },
  ]);

  const runtime = snapshotRuntimeFixture(undefined, {
    captureSnapshot: async (device, input, signal) => {
      const result = await captureSnapshotWithInteractor({
        device,
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
  expect(elementTree).toHaveBeenCalledOnce();
  expect(providerNodes).toEqual([
    ['Application', 'App'],
    ['Table', 'Settings'],
    ['Cell', 'Target'],
    ['Button', 'Save'],
    ['StaticText', 'Save'],
  ]);
  expect(response.data.nodes?.map((node) => [node.type, node.label])).toEqual(providerNodes);
  expect(response.data).not.toHaveProperty('truncated');

  const cliOutput = await snapshotCliOutput({
    result: response.data as unknown as CaptureSnapshotResult,
  });
  expect(cliOutput.jsonData).not.toHaveProperty('truncated');
});
