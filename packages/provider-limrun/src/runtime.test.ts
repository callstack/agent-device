import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import type { AppsFilter, DeviceLease } from '@agent-device/contracts/device';
import type { Interactor } from '@agent-device/contracts/interactor-types';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import type { PlatformRequestScope } from '@agent-device/contracts/platform-runtime-host';
import {
  androidAdbHostTarget,
  androidAdbInvocation,
  androidAdbSerialTarget,
} from '@agent-device/platform-android/mechanics';
import { createLimrunRuntime } from './runtime.ts';
import { unusedLimrunRuntimeHost } from './runtime.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import type {
  LimrunAdbExecutor,
  LimrunAdbProvider,
  LimrunRuntimeDependencies,
} from './runtime-dependencies.ts';

/**
 * The provider's platform module is the daemon's real load path: `createLimrunRuntime(...,
 * { includePlatformModule: true })`, then `loadRuntime(host)`, then `bind`. These cases drive the
 * app-state reader `loadLimrunPlatformRuntime` wires onto the runtime implementation through that
 * entry, which no owner-level test reaches because those hand-author their owner options.
 */

const state = vi.hoisted(() => ({
  foreground: { appId: 'com.example.app', activity: '.MainActivity' } as
    | { appId?: string; activity?: string }
    | undefined,
  disconnect: vi.fn(),
  tunnelClose: vi.fn(),
  captureTunnelClose: vi.fn(),
  onInspectionEvent: undefined as ((event: unknown) => void) | undefined,
  androidCreate: vi.fn(async () => ({
    metadata: { id: 'android-instance-1' },
    status: {
      token: 'instance-token',
      apiUrl: 'https://android.example',
      adbWebSocketUrl: 'wss://adb.example',
    },
  })),
  androidDelete: vi.fn(async (_instanceId: string) => {
    await state.deleteGate;
    if (state.deleteFails) throw new Error('Limrun refused to delete the instance');
  }),
  /** Made to reject by a case whose instance delete is refused, the one failure a lease may not swallow. */
  deleteFails: false,
  /**
   * Held by a case whose instance delete must answer later than the deadline its own route gives it, which is
   * the shape a DELETE whose response body never arrives has.
   */
  deleteGate: undefined as Promise<void> | undefined,
  keepAlive: vi.fn(),
  /** Instance-client connections the provider made, so one lease can be shown to make one. */
  connectCount: 0,
  /**
   * Held by a case that has to keep a create in flight after its instance was rented, which is the window
   * in which a release or a daemon close has to find the instance.
   */
  createGate: undefined as Promise<void> | undefined,
  /**
   * Held by a case that has to keep a session's destination tunnel or ADB tunnel in flight, which is the
   * window a release has to cover for a tunnel that has not been opened yet.
   */
  tunnelGate: undefined as Promise<void> | undefined,
  /** Made to throw by a case whose session connection fails after its instance was rented. */
  connectFails: false,
  /** Uploaded apps the catalog answers for a case that asks for an app to preinstall. */
  uploadedApps: [] as unknown[],
  /** What the device reports installed, for a case whose app identifier cannot be resolved. */
  installedApps: [] as Array<{ id: string; name?: string }>,
  /** Destination tunnels and ADB tunnels this runtime asked the SDK to open. */
  captureStarts: 0,
  adbTunnelStarts: 0,
  /**
   * The ADB provider last handed to an interactor, which is the handle a caller keeps for a session whose
   * lease has since ended.
   */
  heldAdbProvider: undefined as LimrunAdbProvider | undefined,
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };
    readonly androidInstances = {
      create: async () => {
        const instance = await state.androidCreate();
        await state.createGate;
        return instance;
      },
      // Expired-lease recovery finds nothing under this lease's labels, so a release of a lease the
      // runtime lost answers nothing rather than reaching an unstubbed SDK call.
      list: vi.fn(async () => ({ getPaginatedItems: () => [] })),
      delete: state.androidDelete,
    };
    readonly assets = {
      getOrUpload: vi.fn(),
      list: vi.fn(async () => state.uploadedApps),
    };
  },
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => {
    state.connectCount += 1;
    if (state.connectFails) throw new Error('instance connection refused');
    return {
      disconnect: state.disconnect,
      keepAlive: state.keepAlive,
      openUrl: vi.fn(),
      sendAsset: vi.fn(),
      pressKey: vi.fn(),
      setText: vi.fn(),
      tap: vi.fn(),
      startAdbTunnel: vi.fn(async () => {
        state.adbTunnelStarts += 1;
        await state.tunnelGate;
        return { address: { address: '127.0.0.1', port: 62_001 }, close: state.tunnelClose };
      }),
      startTunnel: vi.fn(async (options: { onInspectionEvent: (event: unknown) => void }) => {
        state.captureStarts += 1;
        state.onInspectionEvent = options.onInspectionEvent;
        await state.tunnelGate;
        return { tunnelId: 't1', selectors: [], close: state.captureTunnelClose };
      }),
      getTunnelStatus: vi.fn(async () => ({
        lastDialFailure: { tunnelId: 't1', reason: 'dns_not_found' },
      })),
    };
  }),
}));

/**
 * One lease has one set of resources, however many routes arrive at it: a leased instance cannot be rented
 * twice, left untracked by a release or a daemon close that raced its create, or kept alive after it is
 * gone. The mock `state` is shared by this file, so each case measures from its own baseline.
 */

test('two allocations of one lease rent one instance and start one keep-alive timer', async () => {
  let reportCreate!: () => void;
  state.createGate = new Promise<void>((resolve) => {
    reportCreate = resolve;
  });
  const { connects, creates, deletes, disconnects } = limrunActivity();
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', keepAlive: true },
    testDependencies(),
  );
  let started: ReturnType<typeof vi.spyOn> | undefined;
  try {
    // The second call arrives while the first one's create is still running.
    const first = runtime.leaseLifecycle.allocate?.(androidLease('lease-race'));
    const second = runtime.leaseLifecycle.allocate?.(androidLease('lease-race'));
    await waitForCreate(creates + 1);
    started = vi.spyOn(globalThis, 'setInterval');
    reportCreate();

    assert.equal((await first)?.limrunInstanceId, 'android-instance-1');
    assert.equal((await second)?.limrunInstanceId, 'android-instance-1');
    assert.equal(state.connectCount - connects, 1);
    assert.equal(started.mock.calls.length, 1);
  } finally {
    started?.mockRestore();
    // Whatever this case asserted, the create is answered before it is torn down, so a failed assertion
    // surfaces as a failure rather than as a shutdown that waits out its create budget.
    reportCreate();
    await runtime.shutdown();
    state.createGate = undefined;
  }
  // The second allocation is not an orphaned session behind the first: one create, one connection, one delete.
  const activity = limrunActivity();
  assert.equal(activity.creates - creates, 1);
  assert.equal(activity.connects - connects, 1);
  assert.deepEqual(
    state.androidDelete.mock.calls.slice(deletes).map(([instanceId]) => instanceId),
    ['android-instance-1'],
  );
  assert.equal(activity.disconnects - disconnects, 1);
});

test('a release that arrives before the create answered ends the instance that create made', async () => {
  let reportCreate!: () => void;
  state.createGate = new Promise<void>((resolve) => {
    reportCreate = resolve;
  });
  const { creates, deletes, disconnects } = limrunActivity();
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', keepAlive: true },
    testDependencies(),
  );
  const lease = androidLease('lease-race-release');
  let started: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const allocating = runtime.leaseLifecycle.allocate?.(lease);
    const refused = refusalOf(allocating);
    await waitForCreate(creates + 1);
    started = vi.spyOn(globalThis, 'setInterval');

    const released = runtime.leaseLifecycle.release?.(lease);
    reportCreate();

    // The release cannot answer before the instance it is waiting for exists, so it names what it ended.
    assert.deepEqual(await released, { limrunInstanceId: 'android-instance-1' });
    // The allocation whose instance was taken from it is refused rather than handed a dead session.
    const error = await refused;
    assert.ok(
      error instanceof AppError &&
        error.details?.reason === 'limrun_lease_released_mid_allocation' &&
        error.details.limrunInstanceId === 'android-instance-1',
      `expected the allocation to be refused for the release, got ${String(error)}`,
    );
    assert.equal(started.mock.calls.length, 0);
    assert.deepEqual(
      state.androidDelete.mock.calls.slice(deletes).map(([instanceId]) => instanceId),
      ['android-instance-1'],
    );
    assert.equal(state.disconnect.mock.calls.length - disconnects, 1);
  } finally {
    started?.mockRestore();
    reportCreate();
    await runtime.shutdown();
    state.createGate = undefined;
  }
  // One instance, so one delete: the allocation's own refusal does not end a second one.
  assert.equal(state.androidDelete.mock.calls.length - deletes, 1);
});

test('a shutdown while the create runs ends the instance that create made', async () => {
  let reportCreate!: () => void;
  state.createGate = new Promise<void>((resolve) => {
    reportCreate = resolve;
  });
  const { creates, deletes } = limrunActivity();
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', keepAlive: true },
    testDependencies(),
  );
  let started: ReturnType<typeof vi.spyOn> | undefined;
  try {
    const allocating = runtime.leaseLifecycle.allocate?.(androidLease('lease-race-shutdown'));
    const refused = refusalOf(allocating);
    await waitForCreate(creates + 1);
    started = vi.spyOn(globalThis, 'setInterval');

    const closing = runtime.shutdown();
    reportCreate();
    await closing;

    const error = await refused;
    assert.ok(
      error instanceof AppError && error.details?.reason === 'limrun_lease_released_mid_allocation',
      `expected the allocation to be refused for the shutdown, got ${String(error)}`,
    );
    assert.equal(started.mock.calls.length, 0);
    // Nothing may allocate into a runtime that was told to end every instance it holds.
    await assert.rejects(
      async () => await runtime.leaseLifecycle.allocate?.(androidLease('lease-after-shutdown')),
      (error) => error instanceof AppError && error.details?.reason === 'limrun_runtime_shut_down',
    );
    assert.deepEqual(
      state.androidDelete.mock.calls.slice(deletes).map(([instanceId]) => instanceId),
      ['android-instance-1'],
    );
  } finally {
    started?.mockRestore();
    reportCreate();
    state.createGate = undefined;
  }
});

/** Lets an allocation reach the instance create, which is a few module loads away, without clock waits. */
async function waitForCreate(calls: number): Promise<void> {
  await vi.waitFor(() => assert.equal(state.androidCreate.mock.calls.length, calls));
}

test('a release that arrives before the allocation yields ends the instance its create rents', async () => {
  const { creates, deletes } = limrunActivity();
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-release-before-yield');
  try {
    // Neither call is awaited between: the release arrives at the allocation's first suspension point.
    const allocating = runtime.leaseLifecycle.allocate?.(lease);
    const refused = refusalOf(allocating);
    const released = runtime.leaseLifecycle.release?.(lease);

    // The release had an owner to take, so it answers for the instance that create went on renting.
    assert.deepEqual(await released, { limrunInstanceId: 'android-instance-1' });
    assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
    const error = await refused;
    assert.ok(
      error instanceof AppError &&
        error.details?.reason === 'limrun_lease_released_mid_allocation' &&
        error.details.limrunInstanceId === 'android-instance-1',
      `expected the allocation to be refused for the release, got ${String(error)}`,
    );
  } finally {
    await runtime.shutdown();
  }
  // One instance was rented and one was ended; the refused allocation did not rent another.
  assert.equal(state.androidCreate.mock.calls.length - creates, 1);
  assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
});

test('the create of a new lease refuses a profile flag it is given no field for', async () => {
  const { creates } = limrunActivity();
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  try {
    await assert.rejects(
      async () =>
        await runtime.leaseLifecycle.allocate?.(androidLease('lease-refused-flag'), {
          flags: { providerNetworkLogs: true, providerOsVersion: '15' },
        }),
      (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
    );
  } finally {
    await runtime.shutdown();
  }
  // Nothing was billed before the refused flag was answered for.
  assert.equal(state.androidCreate.mock.calls.length - creates, 0);
});

test('a create that failed after renting keeps its unconfirmed delete for the next route', async () => {
  const { deletes } = limrunActivity();
  state.connectFails = true;
  state.deleteFails = true;
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  try {
    // The instance was rented before the session connection failed, and Limrun refused this delete.
    const error = await refusalOf(
      runtime.leaseLifecycle.allocate?.(androidLease('lease-rented-then-failed')),
    );
    assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
    assert.ok(
      error instanceof AppError &&
        error.details?.reason === 'limrun_instance_delete_unconfirmed' &&
        error.details.limrunInstanceId === 'android-instance-1',
      `expected the allocation to report the unended instance, got ${String(error)}`,
    );

    // The lease is still held, so the daemon close retries the delete it could not confirm.
    state.deleteFails = false;
    await runtime.shutdown();
  } finally {
    state.connectFails = false;
    state.deleteFails = false;
    await runtime.shutdown();
  }
  // The retried delete ended the same instance the create rented, rather than forgetting it was owed.
  assert.deepEqual(deletedInstances(deletes), ['android-instance-1', 'android-instance-1']);
});

test('two allocations that ask for traffic logs open one destination tunnel', async () => {
  const { captures, captureCloses } = limrunActivity();
  let reportTunnel!: () => void;
  state.tunnelGate = new Promise<void>((resolve) => {
    reportTunnel = resolve;
  });
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: mkdtempForTestSync('limrun-har-') },
    testDependencies(),
  );
  const lease = androidLease('lease-capture-race');
  try {
    await runtime.leaseLifecycle.allocate?.(lease);
    // Both repeat allocations ask for the capture while the first one's tunnel is still being opened.
    const first = runtime.leaseLifecycle.allocate?.(lease, {
      flags: { providerNetworkLogs: true },
    });
    const second = runtime.leaseLifecycle.allocate?.(lease, {
      flags: { providerNetworkLogs: true },
    });
    await waitForNewOpen(captures, () => state.captureStarts);
    reportTunnel();
    await Promise.all([first, second]);

    // The second allocation joined the start in flight rather than opening a tunnel whose `already_active`
    // refusal would be reported over the capture that is working.
    assert.equal(state.captureStarts - captures, 1);
  } finally {
    // Opened before teardown for the same reason as the create gate above.
    reportTunnel();
    state.tunnelGate = undefined;
    await runtime.shutdown();
  }
  assert.equal(state.captureTunnelClose.mock.calls.length - captureCloses, 1);
});

test('a release that arrives while a tunnel is opening ends the tunnel that answers late', async () => {
  const { captures, captureCloses, deletes } = limrunActivity();
  let reportTunnel!: () => void;
  state.tunnelGate = new Promise<void>((resolve) => {
    reportTunnel = resolve;
  });
  const harDir = mkdtempForTestSync('limrun-har-');
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: harDir },
    testDependencies(),
  );
  const lease = androidLease('lease-capture-teardown');
  try {
    await runtime.leaseLifecycle.allocate?.(lease);

    // The capture's destination tunnel is still being opened when the release arrives.
    const capturing = refusalOf(
      runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } }),
    );
    await waitForNewOpen(captures, () => state.captureStarts);
    const released = runtime.leaseLifecycle.release?.(lease);
    reportTunnel();

    const record = (await released) as Record<string, unknown>;
    assert.equal(record.limrunInstanceId, 'android-instance-1');
    assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
    // The release wrote the capture's record as well, so `artifacts` can still name the HAR.
    assert.equal(
      (record.cloudArtifacts as { cloudArtifacts: { url?: string }[] }).cloudArtifacts[0]?.url,
      path.join(harDir, `${lease.leaseId}.har`),
    );
    const error = await capturing;
    assert.ok(
      error instanceof AppError && error.details?.reason === 'limrun_lease_released_mid_allocation',
      `expected the capture allocation to be refused for the release, got ${String(error)}`,
    );
  } finally {
    reportTunnel();
    state.tunnelGate = undefined;
    await runtime.shutdown();
  }
  // The release owned a tunnel whose open had not answered, and ended it where it landed.
  assert.equal(state.captureTunnelClose.mock.calls.length - captureCloses, 1);
});

test('a release stops waiting on a stuck ADB tunnel, deletes the instance and says what it left', async () => {
  const { deletes, disconnects, adbTunnels, tunnelCloses } = limrunActivity();
  let reportTunnel!: () => void;
  state.tunnelGate = new Promise<void>((resolve) => {
    reportTunnel = resolve;
  });
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-stuck-tunnel');
  let refusedCommand: Promise<unknown> | undefined;
  vi.useFakeTimers();
  try {
    const device = await allocateAndroidDevice(runtime, lease.leaseId);
    if (!runtime.getInteractor(device)) throw new Error('Limrun runtime must return an interactor');
    // A retained interactor raises this session's ADB tunnel, an `adb connect` the SDK starts without a
    // deadline; it is still stuck when the release arrives.
    const command = heldAdbCommand(['shell', 'echo', 'held']);
    refusedCommand = refusalOf(command);
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(state.adbTunnelStarts - adbTunnels, 1);

    const released = runtime.leaseLifecycle.release?.(lease);
    await vi.advanceTimersByTimeAsync(0);
    // The delete does not queue behind the stuck tunnel: it was asked for while that tunnel was still open.
    assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
    assert.equal(state.disconnect.mock.calls.length - disconnects, 1);

    // The release's own budget for the local teardown elapses; the delete it ran beside is already answered.
    await vi.advanceTimersByTimeAsync(LOCAL_TEARDOWN_WAIT_MS);
    const [warning] = warningsOf(await released);
    assert.equal(warning?.code, 'LIMRUN_TEARDOWN_INCOMPLETE');
    // The report names the work this route stopped waiting for, and the instance it left a host endpoint on.
    assert.match(String(warning?.message), /Local teardown/);
    assert.equal(warning?.limrunInstanceId, 'android-instance-1');
    // The lease is given back: the stuck tunnel is reported, not held over the next allocation.
    await runtime.leaseLifecycle.allocate?.(lease);

    reportTunnel();
    await vi.advanceTimersByTimeAsync(0);
    const refused = await refusedCommand;
    assert.ok(
      refused instanceof AppError && refused.details?.reason === 'limrun_adb_tunnel_cleaned_up',
      `expected the retained command to be refused, got ${String(refused)}`,
    );
  } finally {
    reportTunnel();
    vi.useRealTimers();
    state.tunnelGate = undefined;
    await runtime.shutdown();
    await (refusedCommand ?? Promise.resolve());
  }
  // The tunnel that answered into a retired session was closed where it landed, and no second one was raised.
  assert.equal(state.adbTunnelStarts - adbTunnels, 1);
  assert.equal(state.tunnelClose.mock.calls.length - tunnelCloses, 1);
});

/** The retained interactor's own ADB handle, driven outside any request this runtime is serving. */
function heldAdbCommand(args: readonly string[]): Promise<unknown> {
  const provider = state.heldAdbProvider;
  if (!provider) throw new Error('Expected the runtime to hand an interactor an ADB provider');
  return provider.exec(args);
}

function warningsOf(record: Record<string, unknown> | undefined): WarningRecord[] {
  return Array.isArray(record?.warnings) ? (record.warnings as WarningRecord[]) : [];
}

type WarningRecord = Readonly<{
  code?: string;
  message?: string;
  limrunInstanceId?: string;
}>;

/**
 * Longer than the release's own budget for the local resources it started beside the delete, which is what
 * the case waits out. The delete is asked for independently of it.
 */
const LOCAL_TEARDOWN_WAIT_MS = 60_000;

/** Longer than one delete's deadline, which is what the silent-delete case waits out. */
const DELETE_ANSWER_WAIT_MS = 40_000;

/** Longer than a disposal's budget for its create, which is what the late-create case waits out. */
const CREATE_ANSWER_WAIT_MS = 130_000;

/**
 * Why one racing call refused, captured from the moment it starts. Two routes can answer in either order,
 * and the one that answers first must not leave the other's refusal unobserved.
 */
function refusalOf(call: Promise<unknown> | undefined): Promise<unknown> {
  return (call ?? Promise.resolve()).then(
    () => undefined,
    (error: unknown) => error,
  );
}

/** Where the shared instance-control mocks stand, so a case can measure only what it caused. */
function limrunActivity(): {
  creates: number;
  deletes: number;
  disconnects: number;
  connects: number;
  captures: number;
  captureCloses: number;
  adbTunnels: number;
  tunnelCloses: number;
} {
  return {
    creates: state.androidCreate.mock.calls.length,
    deletes: state.androidDelete.mock.calls.length,
    disconnects: state.disconnect.mock.calls.length,
    connects: state.connectCount,
    captures: state.captureStarts,
    captureCloses: state.captureTunnelClose.mock.calls.length,
    adbTunnels: state.adbTunnelStarts,
    tunnelCloses: state.tunnelClose.mock.calls.length,
  };
}

/** The instance ids the runtime asked Limrun to delete after a case's own baseline. */
function deletedInstances(from: number): string[] {
  return state.androidDelete.mock.calls.slice(from).map(([instanceId]) => instanceId as string);
}

/** Lets a case reach a resource a call is on its way to opening, without clock waits. */
async function waitForNewOpen(starts: number, opened: () => number): Promise<void> {
  await vi.waitFor(() => assert.ok(opened() > starts, 'expected a new tunnel to be attempted'));
}

test('the platform module answers app state from the live Android provider session', async () => {
  const registration = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'test-instance' },
    testDependencies(),
    { includePlatformModule: true },
  );
  try {
    const device = await allocateAndroidDevice(registration.runtime);
    const owner = await registration.platformModule.loadRuntime(unusedLimrunRuntimeHost());
    const binding = await owner.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: requestScope(),
    });

    assert.equal(binding.facts.operations.appState.available, true);
    assert.deepEqual(await binding.operations.appState?.(), {
      package: 'com.example.app',
      activity: '.MainActivity',
    });

    // An instance with no foreground application answers with an empty state rather than failing.
    state.foreground = undefined;
    assert.deepEqual(await binding.operations.appState?.(), {
      package: undefined,
      activity: undefined,
    });
  } finally {
    await registration.runtime.shutdown();
  }
});

test('the platform module refuses app state once the provider session died behind the device id', async () => {
  const registration = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'test-instance' },
    testDependencies(),
    { includePlatformModule: true },
  );
  try {
    const device = await allocateAndroidDevice(registration.runtime);
    const owner = await registration.platformModule.loadRuntime(unusedLimrunRuntimeHost());
    const binding = await owner.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: requestScope(),
    });
    // The lease can end between admission and the read; the reader fails closed on the lost
    // session instead of reporting a foreground app it can no longer observe.
    await registration.runtime.shutdown();

    await assert.rejects(
      async () => await binding.operations.appState?.(),
      (error) => error instanceof AppError && error.code === 'UNSUPPORTED_OPERATION',
    );
  } finally {
    await registration.runtime.shutdown();
  }
});

test('the runtime inventory answers only for its own live lease', async () => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  try {
    // A request for another provider or without a lease is not the runtime's to answer.
    assert.equal(await runtime.deviceInventoryProvider?.({ leaseProvider: 'maestro' }), null);
    assert.equal(await runtime.deviceInventoryProvider?.({ leaseProvider: 'limrun' }), null);
    // A limrun lease with no live session declines; the daemon keeps its own inventory answer.
    assert.equal(
      await runtime.deviceInventoryProvider?.({ leaseProvider: 'limrun', leaseId: 'lease-none' }),
      null,
    );

    const device = await allocateAndroidDevice(runtime, 'lease-inventory');
    const request = { leaseProvider: 'limrun', leaseId: 'lease-inventory' };
    assert.deepEqual(await runtime.deviceInventoryProvider?.(request), [device]);
    // A platform filter that cannot match the leased platform answers an authoritative empty set.
    assert.deepEqual(
      await runtime.deviceInventoryProvider?.({ ...request, platform: 'apple' }),
      [],
    );
  } finally {
    await runtime.shutdown();
  }
});

test('the platform module surfaces an aborted request inside the app-state reader', async () => {
  const registration = createLimrunRuntime(
    { apiKey: 'lim_test_key', runtimeInstance: 'test-instance' },
    testDependencies(),
    { includePlatformModule: true },
  );
  const abort = new AbortController();
  try {
    const device = await allocateAndroidDevice(registration.runtime);
    const owner = await registration.platformModule.loadRuntime(unusedLimrunRuntimeHost());
    const binding = await owner.bind({
      device,
      intent: { kind: 'ordinary' },
      scope: requestScope(abort.signal),
    });
    abort.abort(new AppError('COMMAND_CANCELLED', 'fixture request canceled'));

    await assert.rejects(
      async () => await binding.operations.appState?.(),
      (error) => error instanceof AppError && error.code === 'COMMAND_CANCELLED',
    );
  } finally {
    await registration.runtime.shutdown();
  }
});

test('a network capture writes a private HAR with its failures on artifacts and at release', async () => {
  const captureCloses = state.captureTunnelClose.mock.calls.length;
  const harDir = mkdtempForTestSync('limrun-har-');
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: harDir },
    testDependencies(),
  );
  const lease = androidLease('lease-capture');
  const harPath = path.join(harDir, `${lease.leaseId}.har`);
  // A HAR left by an earlier capture becomes private when it is rewritten.
  fs.writeFileSync(harPath, '', { mode: 0o644 });
  try {
    // A repeat allocation of the live lease starts the capture it newly asks for.
    await runtime.leaseLifecycle.allocate?.(lease);
    await runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } });
    for (let index = 0; index < 499; index += 1) {
      state.onInspectionEvent?.(completedRequest(`https://api.example.com/${index}`));
    }
    state.onInspectionEvent?.(
      completedRequest('https://missing.example.com/', 'client_dial_failed'),
    );
    // Truncation is a buffer statistic, so it keeps the failure that came before it.
    state.onInspectionEvent?.(completedRequest('https://api.example.com/last'));

    const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
    assert.equal(listed?.cloudArtifacts[0]?.url, harPath);
    const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));
    assert.equal(har.log.entries.length, 500);
    assert.equal(har.log.entries.at(-2).response.status, 0);
    assert.equal(fs.statSync(harPath).mode & 0o777, 0o600);
    assert.deepEqual(listed?.cloudArtifacts[0]?.metadata, {
      failures: {
        count: 1,
        last: { kind: 'request-failed', host: 'missing.example.com', port: 443 },
        lastDialFailure: 'dns_not_found',
        truncated: 1,
      },
    });

    const released = (await runtime.leaseLifecycle.release?.(lease)) as {
      cloudArtifacts?: { cloudArtifacts: { url?: string }[]; message?: string };
    };
    assert.equal(released.cloudArtifacts?.cloudArtifacts[0]?.url, harPath);
    assert.equal(state.captureTunnelClose.mock.calls.length - captureCloses, 1);
    assert.match(
      String(released.cloudArtifacts?.message),
      /last request-failed missing\.example\.com:443/,
    );
    const afterClose = await runtime.cloudArtifacts?.listCloudArtifacts?.({
      leaseId: lease.leaseId,
    });
    assert.equal(afterClose?.cloudArtifacts[0]?.url, harPath);
  } finally {
    await runtime.shutdown();
  }
});

test('released captures past the record limit forget the oldest released lease first', async () => {
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: mkdtempForTestSync('limrun-har-') },
    testDependencies(),
  );
  const live = androidLease('lease-live-unavailable');
  try {
    await runtime.leaseLifecycle.allocate?.(live, {
      flags: { providerNetworkLogs: true, providerNetworkHosts: 'not a host' },
    });
    for (let index = 0; index < 33; index += 1) {
      const lease = androidLease(`lease-released-${index}`);
      await runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } });
      await runtime.leaseLifecycle.release?.(lease);
    }
    const list = async (leaseId: string) =>
      (await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId }))?.status;
    assert.equal(await list('lease-released-0'), undefined);
    assert.equal(await list('lease-released-1'), undefined);
    assert.equal(await list('lease-released-32'), 'ready');
    assert.equal(await list(live.leaseId), 'unavailable');
  } finally {
    await runtime.shutdown();
  }
});

test('a network capture that cannot start is an unavailable artifact with its typed reason', async () => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-no-dir');
  try {
    await runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } });
    const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
    assert.equal(listed?.status, 'unavailable');
    assert.deepEqual(listed?.cloudArtifacts[0]?.metadata, { reason: 'capture-dir-unset' });
  } finally {
    await runtime.shutdown();
  }
});

/**
 * A DELETE whose response body never arrives answers later than any route may wait: the SDK clears its fetch
 * timer before it reads the body, so the request itself is what has to be bounded.
 */
test('a release refuses a delete that never answers, within that delete’s own deadline', async () => {
  const { deletes, disconnects } = limrunActivity();
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-silent-delete');
  let reportDelete!: () => void;
  state.deleteGate = new Promise<void>((resolve) => {
    reportDelete = resolve;
  });
  vi.useFakeTimers();
  try {
    await runtime.leaseLifecycle.allocate?.(lease);
    const refused = refusalOf(runtime.leaseLifecycle.release?.(lease));
    await vi.advanceTimersByTimeAsync(DELETE_ANSWER_WAIT_MS);
    const error = await refused;
    // The lease is still held: Limrun never confirmed the instance was gone.
    assert.ok(
      error instanceof AppError &&
        error.details?.reason === 'limrun_instance_delete_unconfirmed' &&
        error.details.limrunInstanceId === 'android-instance-1' &&
        /delete/i.test(String(error.details.cause)),
      `expected the release to refuse within its delete deadline, got ${String(error)}`,
    );
    // What that delete goes on to answer is still observed: its late confirmation ends the lease.
    reportDelete();
    await vi.advanceTimersByTimeAsync(0);
  } finally {
    reportDelete();
    state.deleteGate = undefined;
    vi.useRealTimers();
    await runtime.shutdown();
  }
  assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
  assert.equal(state.disconnect.mock.calls.length - disconnects, 1);
});

/** A create that answers after its disposal gave up still owes the end of whatever it names. */
test('a create that answers after its disposal gave up ends the instance it rents', async () => {
  const { creates, deletes, connects, disconnects } = limrunActivity();
  let reportCreate!: () => void;
  state.createGate = new Promise<void>((resolve) => {
    reportCreate = resolve;
  });
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-late-create');
  try {
    const refusedAllocation = refusalOf(runtime.leaseLifecycle.allocate?.(lease));
    await waitForCreate(creates + 1);
    const refusedRelease = refusalOf(runtime.leaseLifecycle.release?.(lease));
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(CREATE_ANSWER_WAIT_MS);
    // The release refused rather than waiting longer, and the create has still not named anything.
    assert.ok(
      (await refusedRelease) instanceof AppError,
      'expected the release to refuse once its create budget expired',
    );
    assert.deepEqual(deletedInstances(deletes), []);
    // The POST answers after that: the instance it names, and the session built on it, belong to the
    // disposal that is already over, so that disposal ends them.
    reportCreate();
    await vi.advanceTimersByTimeAsync(0);
    assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
    assert.equal(state.disconnect.mock.calls.length - disconnects, 1);
    assert.ok((await refusedAllocation) instanceof AppError);
  } finally {
    vi.useRealTimers();
    reportCreate();
    state.createGate = undefined;
    await runtime.shutdown();
  }
  assert.equal(state.androidCreate.mock.calls.length - creates, 1);
  assert.equal(state.connectCount - connects, 1);
});

/** A session built before a later failure is a resource its disposal has to release, not drop. */
test('a create that fails after its session was built disconnects that session', async () => {
  const { deletes, disconnects } = limrunActivity();
  state.uploadedApps = [{ id: 'asset-1', name: 'com.example.app.apk', md5: 'md5', os: 'android' }];
  // The app is installed under something this provider cannot match unambiguously.
  state.installedApps = [{ id: 'com.other.app' }, { id: 'com.other.app.fork' }];
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  try {
    const error = await refusalOf(
      runtime.leaseLifecycle.allocate?.(androidLease('lease-app-unresolved'), {
        initialApp: 'com.example.app.apk',
      }),
    );
    assert.ok(
      error instanceof AppError,
      `expected the app resolution to fail, got ${String(error)}`,
    );
    // The instance it rented is deleted, and so is the connection the session built beside it.
    assert.deepEqual(deletedInstances(deletes), ['android-instance-1']);
    assert.equal(state.disconnect.mock.calls.length - disconnects, 1);
  } finally {
    state.uploadedApps = [];
    state.installedApps = [];
    await runtime.shutdown();
  }
});

/** A joiner with valid flags is not refused for another caller’s refused flag. */
test('a joiner whose own flags are valid allocates despite another caller’s refused flag', async () => {
  const { creates } = limrunActivity();
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-mixed-flags');
  try {
    // The first call carries a flag this provider reads no field for; the second carries none.
    const refused = refusalOf(
      runtime.leaseLifecycle.allocate?.(lease, { flags: { providerOsVersion: '15' } }),
    );
    const joined = await runtime.leaseLifecycle.allocate?.(lease);
    const error = await refused;
    assert.ok(
      error instanceof AppError && error.code === 'INVALID_ARGS',
      `expected the refused caller to be refused for its own flag, got ${String(error)}`,
    );
    assert.equal(joined?.limrunInstanceId, 'android-instance-1');
  } finally {
    await runtime.shutdown();
  }
  // Only the valid caller's lease was billed, and only once.
  assert.equal(state.androidCreate.mock.calls.length - creates, 1);
});

function completedRequest(url: string, error?: string): unknown {
  return {
    type: 'complete',
    sequence: 1,
    requestId: url,
    data: {
      startedDateTime: new Date(0).toISOString(),
      time: 0,
      request: { method: 'GET', url, httpVersion: 'HTTP/1.1', headers: [], cookies: [] },
      response: {
        status: error ? 0 : 200,
        statusText: '',
        httpVersion: '',
        headers: [],
        cookies: [],
      },
      cache: {},
      timings: { send: 0, wait: 0, receive: 0 },
      _limrun: { tunnelId: 't1', selectorId: 's1', ...(error ? { error } : {}) },
    },
  };
}

function requestScope(signal: AbortSignal = new AbortController().signal): PlatformRequestScope {
  return {
    signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
}

async function allocateAndroidDevice(
  runtime: ReturnType<typeof createLimrunRuntime>,
  leaseId = 'lease-appstate',
): Promise<DeviceInfo> {
  const allocation = await runtime.leaseLifecycle.allocate?.(androidLease(leaseId));
  const device = allocation?.device;
  if (!device || typeof device !== 'object') throw new Error('Expected allocated device');
  return device as DeviceInfo;
}

function androidLease(leaseId: string): DeviceLease {
  return {
    leaseId,
    tenantId: 'team-a',
    runId: 'run-a',
    backend: 'android-instance',
    leaseProvider: 'limrun',
    createdAt: 1,
    heartbeatAt: 1,
    expiresAt: 60_001,
  };
}

function testDependencies(): LimrunRuntimeDependencies {
  return {
    clientVersion: 'test-version',
    android: {
      createInteractor: (_device, adb) => {
        state.heldAdbProvider = adb;
        return {} as Interactor;
      },
      createPortReverse: async () => ({
        ensure: async () => {},
        remove: async () => {},
        removeAllOwned: async () => {},
        list: async () => [],
      }),
      inferAppName: async () => 'Example',
      listApps: async (_adb: LimrunAdbExecutor, _filter: AppsFilter) => state.installedApps,
      getForegroundApp: async () => (state.foreground ? { ...state.foreground } : undefined),
      getKeyboardState: async () => ({ visible: false, inputOwner: 'unknown' as const }),
      dismissKeyboard: async () => ({
        visible: false,
        inputOwner: 'unknown' as const,
        attempts: 0,
        wasVisible: false,
        dismissed: false,
      }),
      readLogs: async () => '',
      forceStopApp: async () => {},
      deviceAdbInvocation: (serial: string, command: readonly string[]) =>
        androidAdbInvocation(androidAdbSerialTarget(serial), command),
      hostAdbInvocation: (command: readonly string[]) =>
        androidAdbInvocation(androidAdbHostTarget(), command),
      adbError: async (message: string) => new AppError('COMMAND_FAILED', message),
    },
    host: {
      runAdb: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      archiveDirectory: async () => undefined,
      downloadFile: async () => undefined,
    },
    ios: {
      applySimctlSetting: async () => undefined,
      resolveAppAlias: async (app: string) => app,
      readBundleAppName: async () => undefined,
    },
  } satisfies LimrunRuntimeDependencies;
}
