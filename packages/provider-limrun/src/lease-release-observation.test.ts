import { test, vi, expect } from 'vitest';
import fs from 'node:fs';
import type { DeviceLease } from '@agent-device/contracts/device';
import { createLimrunRuntime } from './runtime.ts';
import { stubLimrunRuntimeDependencies } from './runtime-dependencies.fixtures.ts';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';
import type { LimrunRuntimeDependencies } from './runtime-dependencies.ts';
import { watchUnhandledRejections } from './lifecycle.fixtures.ts';

/*
 * A disposal starts its capture end and its local teardown beside the instance delete and joins them only
 * after it. A step of either one that refuses inside that window has this disposal as its observer from the
 * moment it started: nothing a disposal begins may reach the process as an unhandled rejection, and a
 * refused capture or teardown never changes what the delete answered for.
 */

const state = vi.hoisted(() => ({
  /** Instance deletes this runtime asked Limrun for; each waits for its case to answer it. */
  deletes: [] as Array<{ instanceId: string; report: () => void }>,
  creates: 0,
  createLabels: undefined as Readonly<Record<string, string>> | undefined,
  createError: undefined as Error | undefined,
  listedInstance: undefined as string | undefined,
  listInstances: undefined as ((labelSelector: string) => string[]) | undefined,
  deleteInstance: vi.fn<(instanceId: string) => void>(),
  deleteDispatched: undefined as (() => void) | undefined,
  clientStarts: 0,
  clientGate: undefined as Promise<void> | undefined,
  createGate: undefined as Promise<void> | undefined,
  autoDelete: false,
  disconnects: 0,
  /** Made to throw by the case whose session disconnect refuses while its delete is still owed. */
  disconnectThrows: false,
  captureCloses: 0,
  /** Made to throw by the case whose capture tunnel close refuses as the release writes its record. */
  captureCloseThrows: false,
}));

vi.mock('@limrun/api', () => ({
  default: class MockLimrun {
    readonly iosInstances = { create: vi.fn(), list: vi.fn(), delete: vi.fn() };
    readonly androidInstances = {
      create: async ({ metadata }: { metadata: { labels: Readonly<Record<string, string>> } }) => {
        state.creates += 1;
        state.createLabels = metadata.labels;
        await state.createGate;
        if (state.createError) throw state.createError;
        return {
          metadata: { id: 'android-instance-1' },
          status: {
            token: 'instance-token',
            apiUrl: 'https://android.example',
            adbWebSocketUrl: 'wss://adb.example',
          },
        };
      },
      list: vi.fn(async ({ labelSelector }: { labelSelector: string }) => {
        const ids =
          state.listInstances?.(labelSelector) ??
          (state.listedInstance ? [state.listedInstance] : []);
        return { getPaginatedItems: () => ids.map((id) => ({ metadata: { id } })) };
      }),
      // Every delete waits for its case to answer it, so a release can be held at its delete while the
      // local teardown it started beside has long since refused.
      delete: vi.fn(async (instanceId: string) => {
        state.deleteInstance(instanceId);
        if (state.autoDelete) return;
        let report!: () => void;
        const answered = new Promise<void>((answeredNow) => {
          report = answeredNow;
        });
        state.deletes.push({ instanceId, report });
        state.deleteDispatched?.();
        await answered;
      }),
    };
    readonly assets = { list: vi.fn(async () => []) };
  },
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => {
    state.clientStarts += 1;
    await state.clientGate;
    return {
      disconnect: () => {
        state.disconnects += 1;
        if (state.disconnectThrows) throw new Error('instance client refused to disconnect');
      },
      keepAlive: () => {},
      openUrl: vi.fn(),
      sendAsset: vi.fn(),
      pressKey: vi.fn(),
      setText: vi.fn(),
      tap: vi.fn(),
      startAdbTunnel: vi.fn(async () => ({
        address: { address: '127.0.0.1', port: 62001 },
        close: () => {},
      })),
      startTunnel: vi.fn(async () => ({
        tunnelId: 't1',
        selectors: [],
        close: () => {
          state.captureCloses += 1;
          if (state.captureCloseThrows) throw new Error('capture tunnel refused to close');
        },
      })),
      getTunnelStatus: vi.fn(async () => ({})),
    };
  }),
}));

test('a local teardown that refuses beside a pending delete is reported, not loosed on the process', async () => {
  const rejections = watchUnhandledRejections();
  state.deletes.length = 0;
  const disconnectsBefore = state.disconnects;
  state.disconnectThrows = true;
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-throwing-disconnect');
  let reportDelete: (() => void) | undefined;
  try {
    await runtime.leaseLifecycle.allocate?.(lease);
    // The release holds at its delete while the session disconnect it started beside refuses.
    const released = runtime.leaseLifecycle.release?.(lease);
    await vi.waitFor(() => expect(state.deletes).toHaveLength(1));
    expect(state.disconnects - disconnectsBefore).toBe(1);
    reportDelete = state.deletes[0]?.report;
    reportDelete?.();

    // The delete's confirmation is the release's answer; what the local teardown came to rides beside it
    // as the warning it is: a host resource this process could not put down.
    const record = (await released)?.provider as Record<string, unknown>;
    expect(record.limrunInstanceId).toBe('android-instance-1');
    const warnings = warningsOf(record);
    expect(warnings.map((warning) => warning.code)).toEqual(['LIMRUN_TEARDOWN_INCOMPLETE']);
    expect(String(warnings[0]?.message)).toBe(
      'Local teardown refused to finish: instance client refused to disconnect',
    );
    await rejections.assertIsSilent();
  } finally {
    rejections.stop();
    reportDelete?.();
    state.deletes.forEach(({ report }) => report());
    state.deletes.length = 0;
    state.disconnectThrows = false;
    await runtime.shutdown();
  }
});

test('release clears reverse mappings before disconnect closes their ADB endpoint', async () => {
  const disconnectsBefore = state.disconnects;
  const removed = vi.fn(async () => {});
  const dependencies = testDependencies();
  dependencies.android.createPortReverse = async (adb) => ({
    ensure: async () => {
      await adb(['reverse', 'tcp:18441', 'tcp:18441']);
    },
    list: async () => {
      if (state.disconnects !== disconnectsBefore) throw new Error('ADB endpoint is disconnected');
      return [{ local: 'tcp:18441', remote: 'tcp:18441' }];
    },
    remove: removed,
    removeAllOwned: async () => {},
  });
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, dependencies);
  const lease = androidLease('lease-reverse-before-disconnect');
  try {
    await runtime.leaseLifecycle.allocate?.(lease);
    await runtime.configurePortReverse?.({
      leaseId: lease.leaseId,
      provider: 'limrun',
      devicePort: 18441,
      hostPort: 18441,
      name: 'live-regression',
    });
    const released = runtime.leaseLifecycle.release?.(lease);
    await vi.waitFor(() => expect(state.deletes).toHaveLength(1));
    state.deletes[0]?.report();
    expect((await released)?.provider).toMatchObject({ limrunInstanceId: 'android-instance-1' });
    expect(removed).toHaveBeenCalledWith('tcp:18441');
    expect(state.disconnects - disconnectsBefore).toBe(1);
  } finally {
    state.deletes.forEach(({ report }) => report());
    state.deletes.length = 0;
    await runtime.shutdown();
  }
});

test('a capture close that refuses still leaves the delete it ran beside answered for', async () => {
  const rejections = watchUnhandledRejections();
  const harDir = mkdtempForTestSync('limrun-har-observe-');
  state.deletes.length = 0;
  const captureClosesBefore = state.captureCloses;
  state.captureCloseThrows = true;
  const runtime = createLimrunRuntime(
    { apiKey: 'lim_test_key', networkHarDir: harDir },
    testDependencies(),
  );
  const lease = androidLease('lease-throwing-capture-close');
  try {
    await runtime.leaseLifecycle.allocate?.(lease);
    await runtime.leaseLifecycle.allocate?.(lease, { flags: { providerNetworkLogs: true } });
    let reportDelete: (() => void) | undefined;
    try {
      const released = runtime.leaseLifecycle.release?.(lease);
      await vi.waitFor(() => expect(state.deletes).toHaveLength(1));
      reportDelete = state.deletes[0]?.report;
      reportDelete?.();

      // The record's write ends with the tunnel's close, and that close refuses inside the disposal's
      // join window: the instance the delete confirmed is gone, and the release answers for it.
      const record = (await released)?.provider as Record<string, unknown>;
      expect(record.limrunInstanceId).toBe('android-instance-1');
      expect(state.captureCloses - captureClosesBefore).toBe(1);
      expect(warningsOf(record).map((warning) => warning.message)).toEqual([
        'Capture close failed: capture tunnel refused to close',
      ]);
      const harPath = `${harDir}/${lease.leaseId}.har`;
      expect(record).toMatchObject({
        cloudArtifacts: { status: 'ready', cloudArtifacts: [{ url: harPath }] },
      });
      expect(fs.existsSync(harPath)).toBe(true);
      const listed = await runtime.cloudArtifacts?.listCloudArtifacts?.({ leaseId: lease.leaseId });
      expect(listed).toMatchObject({
        status: 'ready',
        message: expect.stringContaining('capture tunnel refused to close'),
      });
      await rejections.assertIsSilent();
    } finally {
      reportDelete?.();
    }
  } finally {
    rejections.stop();
    state.deletes.forEach(({ report }) => report());
    state.deletes.length = 0;
    state.captureCloseThrows = false;
    await runtime.shutdown();
  }
});

test('a late create with failed local cleanup is freed by the normal take with confirmed deletion', async () => {
  await import('./lease-release.ts');
  const rejections = watchUnhandledRejections();
  const createsBefore = state.creates;
  state.deletes.length = 0;
  state.disconnectThrows = true;
  let reportCreate!: () => void;
  state.createGate = new Promise<void>((resolve) => {
    reportCreate = resolve;
  });
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-late-failed-local');
  const allocating = Promise.resolve(runtime.leaseLifecycle.allocate?.(lease)).catch(
    (error: unknown) => error,
  );
  try {
    await vi.waitFor(() => expect(state.creates - createsBefore).toBe(1));
    const expired = runtime.leaseLifecycle.release?.(lease);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(130_000);
    expect(await expired).toMatchObject({
      release: 'unknown',
      error: { details: { reason: 'limrun_instance_delete_unconfirmed' } },
    });
    reportCreate();
    await vi.advanceTimersByTimeAsync(0);
    expect(state.deletes).toHaveLength(1);
    let answered = false;
    const joining = Promise.resolve(runtime.leaseLifecycle.allocate?.(lease))
      .catch((error: unknown) => error)
      .then((answer) => {
        answered = true;
        return answer;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(answered).toBe(false);
    const release = runtime.leaseLifecycle.release?.(lease);
    state.deletes[0]?.report();
    await vi.advanceTimersByTimeAsync(0);
    const record = (await release)?.provider as Record<string, unknown>;
    expect(record.limrunInstanceId).toBe('android-instance-1');
    expect(warningsOf(record)).toMatchObject([
      {
        code: 'LIMRUN_TEARDOWN_INCOMPLETE',
        message: 'Local teardown refused to finish: instance client refused to disconnect',
      },
    ]);
    expect(await joining).toMatchObject({
      details: {
        reason: 'limrun_lease_released_mid_allocation',
        hint: expect.stringContaining('was ended by the release'),
      },
    });
    await allocating;
    state.disconnectThrows = false;
    state.createGate = undefined;
    await runtime.leaseLifecycle.allocate?.(lease);
    expect(state.creates - createsBefore).toBe(2);
    vi.useRealTimers();
    await rejections.assertIsSilent();
  } finally {
    reportCreate();
    state.createGate = undefined;
    state.disconnectThrows = false;
    state.autoDelete = true;
    state.deletes.forEach(({ report }) => report());
    vi.useRealTimers();
    await runtime.shutdown();
    state.autoDelete = false;
    state.deletes.length = 0;
    rejections.stop();
  }
});

test('a confirmed delete during creation still disconnects the late session without another rent', async () => {
  await import('./lease-release.ts');
  const rejections = watchUnhandledRejections();
  const createsBefore = state.creates;
  const clientsBefore = state.clientStarts;
  const disconnectsBefore = state.disconnects;
  state.deletes.length = 0;
  let reportClient!: () => void;
  state.clientGate = new Promise<void>((resolve) => {
    reportClient = resolve;
  });
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-confirmed-before-session');
  const allocating = Promise.resolve(runtime.leaseLifecycle.allocate?.(lease)).catch(
    (error: unknown) => error,
  );
  try {
    // Reaching the instance client means the one POST has already named the rented instance.
    await vi.waitFor(() => expect(state.clientStarts - clientsBefore).toBe(1));
    const released = runtime.leaseLifecycle.release?.(lease);
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(125_000);
    expect(state.deletes).toHaveLength(1);
    state.deletes[0]?.report();
    await vi.advanceTimersByTimeAsync(50_000);
    expect((await released)?.provider).toMatchObject({
      limrunInstanceId: 'android-instance-1',
      warnings: [{ code: 'LIMRUN_TEARDOWN_INCOMPLETE' }],
    });
    expect(state.disconnects - disconnectsBefore).toBe(0);
    // The owner has been closed, but its observed, memoized local release still owns this session.
    reportClient();
    await vi.advanceTimersByTimeAsync(0);
    expect(await allocating).toMatchObject({
      details: { reason: 'limrun_lease_released_mid_allocation' },
    });
    expect(state.creates - createsBefore).toBe(1);
    expect(state.deletes).toHaveLength(1);
    expect(state.disconnects - disconnectsBefore).toBe(1);
    vi.useRealTimers();
    await rejections.assertIsSilent();
  } finally {
    reportClient();
    state.clientGate = undefined;
    state.deletes.forEach(({ report }) => report());
    vi.useRealTimers();
    await runtime.shutdown();
    state.deletes.length = 0;
    rejections.stop();
  }
});

function warningsOf(record: Record<string, unknown>): Array<Record<string, unknown>> {
  return Array.isArray(record.warnings) ? (record.warnings as Record<string, unknown>[]) : [];
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

/**
 * The host and platform adapters these cases run on: every one of them answers a fixed value. The client
 * connection and the instance delete are driven from the mock `state` above.
 */
function testDependencies(): LimrunRuntimeDependencies {
  return stubLimrunRuntimeDependencies();
}

test('Limrun recovery carries a late labeled delete into the release result', async () => {
  vi.useFakeTimers();
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('lease-late-recovery');
  const dispatched = new Promise<void>((resolve) => {
    state.deleteDispatched = resolve;
  });
  state.listedInstance = 'late-instance';
  try {
    const outcome = runtime.recoverExpiredLease!(lease).catch((error: unknown) => error);
    await dispatched;
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await outcome).toMatchObject({
      details: { reason: 'limrun_instance_delete_unconfirmed' },
    });
    state.deletes[0]?.report();
    state.listedInstance = undefined;
    await expect(runtime.recoverExpiredLease!(lease)).resolves.toBeUndefined();
    expect(state.deletes.map(({ instanceId }) => instanceId)).toEqual(['late-instance']);
  } finally {
    state.deletes.forEach(({ report }) => report());
    state.deletes.length = 0;
    state.listedInstance = undefined;
    state.deleteDispatched = undefined;
    await runtime.shutdown();
    vi.useRealTimers();
  }
});

test('Limrun rental recovery records a matched instance before deleting it', async () => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('rental-inherited');
  const recover = runtime.leaseLifecycle.recoverRental!;
  const journaled = vi.fn();
  try {
    const identity = { reconciliationKey: 'request-key' };
    await expect(recover(lease, identity, journaled)).resolves.toBe(false);
    expect(state.deletes).toHaveLength(0);
    state.listedInstance = 'exact-instance';
    const release = recover(lease, identity, journaled);
    await vi.waitFor(() => expect(state.deletes).toHaveLength(1));
    expect(journaled).toHaveBeenCalledExactlyOnceWith('exact-instance');
    expect(state.deletes[0]?.instanceId).toBe('exact-instance');
    state.deletes[0]?.report();
    await expect(release).resolves.toBe(true);

    state.deletes.length = 0;
    state.listedInstance = 'different-instance';
    const exact = recover(lease, { ...identity, instanceId: 'exact-instance' }, journaled);
    await vi.waitFor(() => expect(state.deletes).toHaveLength(1));
    expect(state.deletes[0]?.instanceId).toBe('exact-instance');
    state.deletes[0]?.report();
    await expect(exact).resolves.toBe(true);
  } finally {
    state.deletes.forEach(({ report }) => report());
    state.deletes.length = 0;
    state.listedInstance = undefined;
    await runtime.shutdown();
  }
});

test.each([
  { result: 'empty', ids: [] },
  { result: 'ambiguous', ids: ['candidate-a', 'candidate-b'] },
])('a journaled lost create stays unknown on $result keyed lookup', async ({ ids }) => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('shared-lease-label');
  const beforeCreate = vi.fn();
  const rented = vi.fn();
  const list = vi.fn((selector: string) =>
    selector === 'provider=limrun,leaseId=shared-lease-label' ? ['older-rental'] : ids,
  );
  state.autoDelete = true;
  state.createError = new Error('create response lost');
  state.listInstances = list;
  state.deleteInstance.mockClear();
  try {
    const failed = await runtime.leaseLifecycle.allocate!(lease, {
      rental: { beforeCreate, rented },
    }).catch((error: unknown) => error);
    const key = state.createLabels?.rentalKey;
    expect(key).toEqual(expect.any(String));
    expect(beforeCreate).toHaveBeenCalledExactlyOnceWith(key);
    expect(list).toHaveBeenCalledExactlyOnceWith(`provider=limrun,rentalKey=${key}`);
    expect(failed).toMatchObject({
      details: { reason: 'limrun_instance_delete_unconfirmed' },
    });
    expect(rented).not.toHaveBeenCalled();
    expect(state.deleteInstance).not.toHaveBeenCalled();

    list.mockReturnValueOnce(['current-rental']);
    await expect(runtime.leaseLifecycle.release!(lease)).resolves.toMatchObject({
      release: 'confirmed',
      provider: { limrunInstanceId: 'current-rental' },
    });
    expect(list).toHaveBeenLastCalledWith(`provider=limrun,rentalKey=${key}`);
    expect(rented).toHaveBeenCalledExactlyOnceWith('current-rental');
    expect(rented).toHaveBeenCalledBefore(state.deleteInstance);
    expect(state.deleteInstance).toHaveBeenCalledExactlyOnceWith('current-rental');
  } finally {
    state.listInstances = () => ['current-rental'];
    try {
      await runtime.shutdown();
    } finally {
      state.listInstances = undefined;
      state.createError = undefined;
      state.autoDelete = false;
    }
  }
});

test('Limrun recovery tracks concurrent rentals sharing one public lease label separately', async () => {
  const runtime = createLimrunRuntime({ apiKey: 'lim_test_key' }, testDependencies());
  const lease = androidLease('shared-lease-label');
  const recover = runtime.leaseLifecycle.recoverRental!;
  const journaledA = vi.fn();
  const journaledB = vi.fn();
  const instancesBySelector = new Map([
    ['provider=limrun,rentalKey=key-a', ['instance-a']],
    ['provider=limrun,rentalKey=key-b', ['instance-b']],
  ]);
  state.listInstances = (selector) => instancesBySelector.get(selector) ?? [];
  state.autoDelete = true;
  state.deleteInstance.mockClear();
  try {
    await expect(
      Promise.all([
        recover(lease, { reconciliationKey: 'key-a' }, journaledA),
        recover(lease, { reconciliationKey: 'key-b' }, journaledB),
      ]),
    ).resolves.toEqual([true, true]);
    expect(journaledA).toHaveBeenCalledExactlyOnceWith('instance-a');
    expect(journaledB).toHaveBeenCalledExactlyOnceWith('instance-b');
    expect(state.deleteInstance.mock.calls.map(([id]) => id).sort()).toEqual([
      'instance-a',
      'instance-b',
    ]);
  } finally {
    state.listInstances = undefined;
    state.autoDelete = false;
    await runtime.shutdown();
  }
});
