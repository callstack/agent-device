import { beforeEach, expect, test, vi } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../../../types.ts';
import { makeSession, makeSessionStore } from '../../../handlers/__tests__/session-test-harness.ts';
import { handleSessionInventoryCommands } from '../inventory.ts';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type RuntimeFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../../../__tests__/test-utils/runtime-operation-facts.ts';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../../request-runtime-binding.ts';

const HARMONY_DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};
const available = { available: true } as const;
const unavailable = { available: false, reason: 'unsupported-platform-leaf' } as const;
const listAppsOperation: PlatformRuntimeOperations['listApps'] = vi.fn(async ({ filter }) =>
  filter === 'all'
    ? [
        { id: 'com.example.application', name: 'application' },
        { id: 'com.ohos.settings', name: 'settings' },
      ]
    : [{ id: 'com.example.application', name: 'application' }],
);
const ensureReady = vi.fn(async () => ({
  ...HARMONY_DEVICE,
  booted: true,
}));

function runtimeFacts(): RuntimeFacts<PlatformRuntimeOperations> {
  return {
    device: { family: 'harmonyos', kind: 'device', target: 'mobile', providerMode: 'local' },
    operations: {
      appLogInspect: available,
      appLogDoctor: available,
      appLogStart: available,
      appLogReattach: available,
      appLogCleanup: available,
      appState: unavailable,
      listApps: { available: true },
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: available,
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

const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async () => runtimeFacts());
let bindCount = 0;
const bindDevice: BindDeviceRuntime = async (device, use) => {
  bindCount += 1;
  return narrowDeviceBinding(
    {
      device,
      owner: localRuntimeOwner('harmonyos'),
      facts: runtimeFacts(),
      operations: { ensureReady, listApps: listAppsOperation },
      [Symbol.asyncDispose]: async () => {},
    },
    use,
  );
};

beforeEach(() => {
  vi.mocked(inspectFacts).mockClear();
  vi.mocked(listAppsOperation).mockClear();
  vi.mocked(ensureReady).mockClear();
  bindCount = 0;
});

async function listApps(appsFilter: 'all' | 'user-installed'): Promise<DaemonResponse | null> {
  const sessionName = 'harmony-apps';
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, HARMONY_DEVICE));
  const req: DaemonRequest = {
    token: 'test-token',
    session: sessionName,
    command: 'apps',
    positionals: [],
    flags: { appsFilter },
  };
  return await handleSessionInventoryCommands({
    req,
    sessionName,
    sessionStore,
    inspectFacts,
    bindDevice,
  });
}

test.each([
  {
    appsFilter: 'user-installed' as const,
    expected: ['application (com.example.application)'],
  },
  {
    appsFilter: 'all' as const,
    expected: ['application (com.example.application)', 'settings (com.ohos.settings)'],
  },
])('HarmonyOS apps preserves the $appsFilter response parity', async ({ appsFilter, expected }) => {
  await expect(listApps(appsFilter)).resolves.toMatchObject({
    ok: true,
    data: { apps: expected },
  });
  expect(inspectFacts).toHaveBeenCalledOnce();
  expect(bindCount).toBe(1);
  expect(ensureReady).toHaveBeenCalledOnce();
  expect(listAppsOperation).toHaveBeenCalledWith({
    device: expect.any(Object),
    filter: appsFilter,
  });
});
