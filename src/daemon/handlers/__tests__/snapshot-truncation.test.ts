import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../snapshot.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import { snapshotCliOutput } from '../../../commands/capture/output.ts';
import {
  makeProviderRuntimeOwning,
  makeSession,
  makeSessionStore,
} from './snapshot-handler-fixture.ts';
import {
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../__tests__/snapshot-runtime-fixture.ts';

vi.mock('../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});

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
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
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
  sessionStore.set(sessionName, makeSession(sessionName, limrunDevice));
  setActiveProviderDeviceRuntimes([makeProviderRuntimeOwning(limrunDevice, 'limrun')]);
  legacyDispatchCapture.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'Application', label: 'Demo' }],
    backend: 'xctest',
    producer: 'limrun-ios-tree',
    warnings: ['tree completeness is not independently verified'],
  });

  const runtime = snapshotRuntimeFixture();
  const response = await handleProductionSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: {},
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
  expect(response.data).not.toHaveProperty('truncated');

  const cliOutput = await snapshotCliOutput({
    result: response.data as unknown as CaptureSnapshotResult,
  });
  expect(cliOutput.jsonData).not.toHaveProperty('truncated');
});
