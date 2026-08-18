import { expect, test, vi } from 'vitest';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  snapshotRuntimeOperationFacts,
  type CaptureSnapshotInput,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
  type SnapshotResult,
} from '@agent-device/contracts/platform';
import { deviceShape } from '@agent-device/kernel/device';
import { makeAndroidSession } from '../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { dispatchSnapshotDiffViaRuntime } from '../snapshot-diff-runtime.ts';
import { unavailableDeviceRuntimeGateway } from './test-device-runtime-gateway.ts';

const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing' as const,
  hint: 'The exact runtime owner cannot capture this snapshot plan.',
});

const baseCapture: SnapshotResult = Object.freeze({
  backend: 'android',
  nodes: [{ index: 0, depth: 0, type: 'Button', label: 'Before' }],
  truncated: false,
});

type SnapshotOperationName =
  | 'captureSnapshot'
  | 'captureSnapshotWithCustomActions'
  | 'captureSnapshotWithoutActiveApp';

async function runtimeHarness(params: {
  captures?: readonly SnapshotResult[];
  customActionsAvailable?: boolean;
  withoutActiveAppAvailable?: boolean;
}) {
  const session = makeAndroidSession('diff-runtime');
  const device = session.device;
  const baseFacts = await unavailableDeviceRuntimeGateway.inspectFacts(device);
  const facts: RuntimeFacts<PlatformRuntimeOperations> = {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      ...baseFacts.operations,
      ...snapshotRuntimeOperationFacts({
        capture: available,
        customActions: params.customActionsAvailable === false ? unavailable : available,
        withoutActiveApp: params.withoutActiveAppAvailable === false ? unavailable : available,
      }),
    },
  };
  const captures = [...(params.captures ?? [baseCapture])];
  const operationCalls = {
    captureSnapshot: vi.fn(async () => captures.shift() ?? baseCapture),
    captureSnapshotWithCustomActions: vi.fn(async () => captures.shift() ?? baseCapture),
    captureSnapshotWithoutActiveApp: vi.fn(async () => captures.shift() ?? baseCapture),
  } satisfies Record<
    SnapshotOperationName,
    (input: CaptureSnapshotInput) => Promise<SnapshotResult>
  >;
  const binding: DeviceBinding<PlatformRuntimeOperations> = {
    device,
    owner: localRuntimeOwner('android'),
    facts,
    operations: operationCalls,
    [Symbol.asyncDispose]: async () => {},
  };
  const inspected: Parameters<InspectDeviceRuntimeFacts>[] = [];
  const boundUses: ReadonlyArray<string>[] = [];
  const inspectFacts: InspectDeviceRuntimeFacts = async (...args) => {
    inspected.push(args);
    return facts;
  };
  const bindDevice: BindDeviceRuntime = async (_device, use) => {
    boundUses.push([...use.required]);
    return narrowDeviceBinding(binding, use);
  };
  return { session, device, facts, operationCalls, inspected, boundUses, inspectFacts, bindDevice };
}

test.each([
  {
    name: 'active app',
    customActions: false,
    activeApp: true,
    required: ['captureSnapshot'],
    selected: 'captureSnapshot',
  },
  {
    name: 'custom actions with active app',
    customActions: true,
    activeApp: true,
    required: ['captureSnapshot', 'captureSnapshotWithCustomActions'],
    selected: 'captureSnapshotWithCustomActions',
  },
  {
    name: 'without active app',
    customActions: false,
    activeApp: false,
    required: ['captureSnapshot', 'captureSnapshotWithoutActiveApp'],
    selected: 'captureSnapshotWithoutActiveApp',
  },
  {
    name: 'custom actions without active app',
    customActions: true,
    activeApp: false,
    required: [
      'captureSnapshot',
      'captureSnapshotWithCustomActions',
      'captureSnapshotWithoutActiveApp',
    ],
    selected: 'captureSnapshotWithCustomActions',
  },
] as const)(
  'admits and binds exactly once for the $name plan',
  async ({ customActions, activeApp, required, selected }) => {
    const harness = await runtimeHarness({});
    const sessionStore = makeSessionStore('agent-device-diff-runtime-plan-');
    sessionStore.set('diff-runtime', {
      ...harness.session,
      ...(activeApp ? { appBundleId: 'com.example.app' } : {}),
    });

    const response = await dispatchSnapshotDiffViaRuntime({
      req: {
        command: 'diff',
        positionals: ['snapshot'],
        token: 't',
        session: 'diff-runtime',
        flags: {
          snapshotCustomActions: customActions,
          snapshotPreferredBackend: 'private-ax',
        },
      },
      sessionName: 'diff-runtime',
      logPath: '/tmp/diff-runtime.log',
      sessionStore,
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    });

    expect(response.ok).toBe(true);
    expect(harness.inspected).toEqual([[harness.device]]);
    expect(harness.boundUses).toEqual([required]);
    for (const [operation, capture] of Object.entries(harness.operationCalls)) {
      expect(capture).toHaveBeenCalledTimes(operation === selected ? 1 : 0);
    }
    expect(harness.operationCalls[selected]).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({ preferredBackend: 'private-ax' }),
      }),
    );
  },
);

test('rejects an unavailable exact-owner fact before binding', async () => {
  const harness = await runtimeHarness({ customActionsAvailable: false });
  const sessionStore = makeSessionStore('agent-device-diff-runtime-unavailable-');
  sessionStore.set('diff-runtime', {
    ...harness.session,
    appBundleId: 'com.example.app',
  });

  const response = await dispatchSnapshotDiffViaRuntime({
    req: {
      command: 'diff',
      positionals: ['snapshot'],
      token: 't',
      session: 'diff-runtime',
      flags: { snapshotCustomActions: true },
    },
    sessionName: 'diff-runtime',
    logPath: '/tmp/diff-runtime.log',
    sessionStore,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(response.ok).toBe(false);
  expect(harness.inspected).toHaveLength(1);
  expect(harness.boundUses).toEqual([]);
  expect(response.ok ? undefined : response.error.details?.reason).toBe('owner-capability-missing');
  expect(response.ok ? undefined : response.error.message).toBe(
    '--actions requires an iOS simulator: custom actions are read through the private accessibility snapshot backend, which android/emulator targets do not have.',
  );
  expect(response.ok ? undefined : response.error.hint).toBe(
    'Re-run without --actions, or target an iOS simulator.',
  );
});

test('preserves initialized, unchanged, and changed diff results through one bound capture', async () => {
  const changedCapture: SnapshotResult = {
    ...baseCapture,
    nodes: [{ index: 0, depth: 0, type: 'Button', label: 'After' }],
  };
  const harness = await runtimeHarness({
    captures: [baseCapture, baseCapture, changedCapture],
  });
  const sessionStore = makeSessionStore('agent-device-diff-runtime-results-');
  sessionStore.set('diff-runtime', { ...harness.session, appBundleId: 'com.example.app' });

  const run = async () =>
    await dispatchSnapshotDiffViaRuntime({
      req: {
        command: 'diff',
        positionals: ['snapshot'],
        token: 't',
        session: 'diff-runtime',
      },
      sessionName: 'diff-runtime',
      logPath: '/tmp/diff-runtime.log',
      sessionStore,
      inspectFacts: harness.inspectFacts,
      bindDevice: harness.bindDevice,
    });

  const initialized = await run();
  const unchanged = await run();
  const changed = await run();

  expect(initialized.ok && initialized.data?.baselineInitialized).toBe(true);
  expect(unchanged.ok && unchanged.data?.summary).toMatchObject({ additions: 0, removals: 0 });
  expect(changed.ok && changed.data?.summary).toMatchObject({ additions: 1, removals: 1 });
  expect(harness.operationCalls.captureSnapshot).toHaveBeenCalledTimes(3);
  expect(harness.operationCalls.captureSnapshot).toHaveBeenLastCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({ preferredBackend: undefined }),
    }),
  );
  expect(harness.operationCalls.captureSnapshotWithCustomActions).not.toHaveBeenCalled();
  expect(harness.operationCalls.captureSnapshotWithoutActiveApp).not.toHaveBeenCalled();
});

test('a sparse internal diff capture returns no screenshot fallback artifact', async () => {
  const harness = await runtimeHarness({
    captures: [
      {
        ...baseCapture,
        quality: {
          state: 'sparse',
          backend: 'private-ax',
          reason: 'root only',
          reasonCode: 'sparse-tree',
        },
      },
    ],
  });
  const sessionStore = makeSessionStore('agent-device-diff-runtime-sparse-');
  sessionStore.set('diff-runtime', { ...harness.session, appBundleId: 'com.example.app' });

  const response = await dispatchSnapshotDiffViaRuntime({
    req: { command: 'diff', positionals: ['snapshot'], token: 't', session: 'diff-runtime' },
    sessionName: 'diff-runtime',
    logPath: '/tmp/diff-runtime.log',
    sessionStore,
    inspectFacts: harness.inspectFacts,
    bindDevice: harness.bindDevice,
  });

  expect(response.ok).toBe(true);
  expect(response.ok ? response.data : undefined).not.toHaveProperty('fallbackScreenshotPath');
  expect(response.ok ? response.data : undefined).not.toHaveProperty('artifacts');
  expect(harness.operationCalls.captureSnapshot).toHaveBeenCalledOnce();
});
