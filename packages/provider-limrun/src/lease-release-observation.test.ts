import { test, vi, expect } from 'vitest';
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
      create: async () => ({
        metadata: { id: 'android-instance-1' },
        status: {
          token: 'instance-token',
          apiUrl: 'https://android.example',
          adbWebSocketUrl: 'wss://adb.example',
        },
      }),
      list: vi.fn(async () => ({ getPaginatedItems: () => [] })),
      // Every delete waits for its case to answer it, so a release can be held at its delete while the
      // local teardown it started beside has long since refused.
      delete: vi.fn(async (instanceId: string) => {
        let report!: () => void;
        const answered = new Promise<void>((answeredNow) => {
          report = answeredNow;
        });
        state.deletes.push({ instanceId, report });
        await answered;
      }),
    };
    readonly assets = { getOrUpload: vi.fn(), list: vi.fn(async () => []) };
  },
}));

vi.mock('@limrun/api/instance-client', () => ({
  createInstanceClient: vi.fn(async () => ({
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
  })),
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
    const record = (await released) as Record<string, unknown>;
    expect(record.limrunInstanceId).toBe('android-instance-1');
    const warnings = warningsOf(record);
    expect(warnings.map((warning) => warning.code)).toEqual(['LIMRUN_TEARDOWN_INCOMPLETE']);
    expect(String(warnings[0]?.message)).toContain('Local teardown refused to finish');
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
    expect(await released).toMatchObject({ limrunInstanceId: 'android-instance-1' });
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
      const record = (await released) as Record<string, unknown>;
      expect(record.limrunInstanceId).toBe('android-instance-1');
      expect(state.captureCloses - captureClosesBefore).toBe(1);
      expect(warningsOf(record).map((warning) => warning.message)).toEqual([
        'Capture record refused to be written',
      ]);
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
