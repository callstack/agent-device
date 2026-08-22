import { beforeEach, expect, test, vi } from 'vitest';
import type { DaemonRequest } from '../../types.ts';
import { makeSession, makeSessionStore } from './session-test-harness.ts';
import { handleSessionInventoryCommands } from '../session-inventory.ts';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type RuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../../__tests__/test-utils/runtime-operation-facts.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';

const MACOS_DEVICE = {
  platform: 'apple' as const,
  appleOs: 'macos' as const,
  id: 'macos-1',
  name: 'macOS test host',
  kind: 'device' as const,
  target: 'desktop' as const,
  booted: true,
};

const appsAvailable = { available: true } as const;
const unavailable = { available: false, reason: 'owner-capability-missing' } as const;

function runtimeFacts(): RuntimeFacts<PlatformRuntimeOperations> {
  return {
    device: {
      family: 'apple',
      appleOs: 'macos',
      kind: 'device',
      target: 'desktop',
      providerMode: 'local',
    },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: unavailable,
      listApps: appsAvailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: appsAvailable,
      bootTarget: unavailable,
      bootTargetHeadless: unavailable,
      ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
      ...applicationLifecycleOperationFacts({
        resolveOpenTarget: unavailable,
        prepareApplicationOpen: unavailable,
        openApplication: unavailable,
        applyRuntimeHints: unavailable,
        clearRuntimeHints: unavailable,
        closeApplication: unavailable,
        finalizeApplicationClose: unavailable,
        prepareAppleRunner: unavailable,
        configureProviderPortReverse: unavailable,
      }),
    },
  };
}

const inspectFactsImpl: InspectDeviceRuntimeFacts = async () => runtimeFacts();
const inspectFacts = vi.fn(inspectFactsImpl);
const ensureReady = vi.fn(async () => MACOS_DEVICE);
const listApps = vi.fn(async () => [{ id: 'com.example.app', name: 'Example' }]);
let bindCount = 0;
const bindDevice: BindDeviceRuntime = async (device, use) => {
  bindCount += 1;
  return narrowDeviceBinding(
    {
      device,
      owner: localRuntimeOwner('apple'),
      facts: runtimeFacts(),
      operations: {
        ensureReady,
        listApps,
      },
      [Symbol.asyncDispose]: async () => {},
    },
    use,
  );
};

beforeEach(() => {
  inspectFacts.mockClear();
  ensureReady.mockClear();
  listApps.mockClear();
  bindCount = 0;
});

test('macOS apps consumes generic readiness and app inventory through one runtime bind', async () => {
  const sessionName = 'macos-apps';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, MACOS_DEVICE));
  const req: DaemonRequest = {
    token: 'test-token',
    session: sessionName,
    command: 'apps',
    positionals: [],
    flags: { appsFilter: 'all' },
  };

  const response = await handleSessionInventoryCommands({
    req,
    sessionName,
    sessionStore,
    inspectFacts,
    bindDevice,
  });

  expect(response).toEqual({ ok: true, data: { apps: ['Example (com.example.app)'] } });
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(bindCount).toBe(1);
  expect(ensureReady).toHaveBeenCalledOnce();
  expect(listApps).toHaveBeenCalledOnce();
});
