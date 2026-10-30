import fs from 'node:fs';
import { expect, test, vi } from 'vitest';
import { createExpiredProviderLeaseReleaser } from '../provider-lease-expiry.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { leaseReleaseRequestFor } from '../../resources/lease-registry-scope.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import { mkdtempForTestSync } from '@agent-device/test-kit';

test('retries an expired live-only provider lease release after a transient failure', async () => {
  vi.useFakeTimers();
  let now = 1_000;
  const leaseRegistry = new LeaseRegistry({
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
  });
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'browserstack',
  });
  const release = vi
    .fn<(lease: DeviceLease) => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('temporary provider outage'))
    .mockResolvedValueOnce({ limrunInstanceId: 'instance-1' });
  const releaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: { release },
    providerRuntimeIds: ['browserstack'],
    retryDelayMs: 10,
  });

  try {
    now = 1_011;
    const expiredLease = leaseRegistry.consumeExpiredLease(lease.leaseId);
    expect(expiredLease).toEqual(lease);
    await releaser.release(expiredLease!);
    expect(release).toHaveBeenCalledTimes(1);
    expect(leaseRegistry.listActiveLeases()).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(10);
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith(lease);
  } finally {
    releaser.shutdown();
    vi.useRealTimers();
  }
});

test('retries a persisted expired provider lease after daemon restart', async () => {
  const stateDir = mkdtempForTestSync('agent-device-expired-provider-lease-');
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });
  const release = vi
    .fn<(lease: DeviceLease) => Promise<Record<string, unknown>>>()
    .mockRejectedValueOnce(new Error('temporary provider outage'))
    .mockResolvedValueOnce({ limrunInstanceId: 'instance-1' });
  const options = {
    recoverExpiredLease: async (expiredLease: typeof lease) => {
      await release(expiredLease);
    },
    stateDir,
    recoverableProviderIds: ['limrun'],
  };
  const firstDaemon = createExpiredProviderLeaseReleaser(options);

  try {
    await firstDaemon.release(lease);
    expect(release).toHaveBeenCalledTimes(1);
    firstDaemon.shutdown();

    const daemonWithoutLimrun = createExpiredProviderLeaseReleaser({
      ...options,
      recoverableProviderIds: [],
    });
    await daemonWithoutLimrun.recoverInherited();
    expect(release).toHaveBeenCalledTimes(1);
    daemonWithoutLimrun.shutdown();

    const restartedDaemon = createExpiredProviderLeaseReleaser(options);
    await restartedDaemon.recoverInherited();
    expect(release).toHaveBeenCalledTimes(2);
    expect(release).toHaveBeenLastCalledWith(lease);
    restartedDaemon.shutdown();
  } finally {
    firstDaemon.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('does not release until the expired lease record is durable', async () => {
  const stateDir = mkdtempForTestSync('agent-device-expired-provider-lease-');
  const lease = new LeaseRegistry().allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'limrun',
  });
  const recoverExpiredLease = vi.fn(async () => undefined);
  const releaser = createExpiredProviderLeaseReleaser({
    recoverExpiredLease,
    stateDir,
    recoverableProviderIds: ['limrun'],
    retryDelayMs: 60_000,
  });
  const writeFile = vi.spyOn(fs, 'writeFileSync').mockImplementationOnce(() => {
    throw new Error('disk full');
  });

  try {
    await releaser.release(lease);
    expect(recoverExpiredLease).not.toHaveBeenCalled();

    writeFile.mockRestore();
    await releaser.retryPending();
    expect(recoverExpiredLease).toHaveBeenCalledWith(lease);
  } finally {
    writeFile.mockRestore();
    releaser.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('shutdown drain reports releases completed before and during its final retry', async () => {
  const leaseRegistry = new LeaseRegistry();
  const releasedBeforeShutdown = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-0',
    leaseProvider: 'browserstack',
  });
  const releasedDuringShutdown = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'browserstack',
  });
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-2',
    leaseProvider: 'browserstack',
  });
  const release = vi
    .fn()
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error('temporary outage'))
    .mockResolvedValue({});
  const releaser = createExpiredProviderLeaseReleaser({
    leaseLifecycleProvider: { release },
    providerRuntimeIds: ['browserstack'],
  });

  try {
    await releaser.release(releasedBeforeShutdown);
    releaser.beginShutdown();
    await releaser.release(releasedDuringShutdown);
    await releaser.release(lease);
    const drained = await releaser.drain(10);

    expect(release).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledWith(lease);
    expect(drained.released).toHaveLength(2);
    expect(drained.released).toEqual(expect.arrayContaining([releasedDuringShutdown, lease]));
    expect(drained.pending).toEqual([]);
  } finally {
    releaser.shutdown();
  }
});

test('a daemon killed while holding a provider lease recovers it on restart', async () => {
  const stateDir = mkdtempForTestSync('agent-device-live-provider-lease-');
  const recoverExpiredLease = vi.fn(async (_lease: DeviceLease) => undefined);
  const options = { recoverExpiredLease, stateDir, recoverableProviderIds: ['revyl'] };
  const killedDaemon = createExpiredProviderLeaseReleaser(options);
  const registry = new LeaseRegistry({
    onProviderLeasesChanged: (leases) => killedDaemon.recordLiveLeases(leases),
  });
  try {
    const held = registry.allocateLease({ tenantId: 't', runId: 'run-1', leaseProvider: 'revyl' });
    // A provider with no recovery has nothing a restart could do, so it is not journaled.
    registry.allocateLease({ tenantId: 't', runId: 'run-2', leaseProvider: 'browserstack' });
    // The process dies here: no release, no expiry, nothing drained.
    killedDaemon.shutdown();

    const restartedDaemon = createExpiredProviderLeaseReleaser(options);
    const startupDiagnostics: { phase: string; data: Record<string, unknown> }[] = [];
    await restartedDaemon.recoverInherited((diagnostic) => startupDiagnostics.push(diagnostic));
    expect(startupDiagnostics).toEqual([
      expect.objectContaining({
        phase: 'provider_lease_orphans_adopted',
        data: { leaseIds: [held.leaseId] },
      }),
    ]);
    expect(recoverExpiredLease.mock.calls.map(([lease]) => lease.leaseId)).toEqual([held.leaseId]);
    expect(fs.existsSync(`${stateDir}/live-provider-leases.json`)).toBe(false);
    restartedDaemon.shutdown();

    // Recovered once means recovered: the next daemon inherits nothing.
    const thirdDaemon = createExpiredProviderLeaseReleaser(options);
    await thirdDaemon.recoverInherited();
    expect(recoverExpiredLease).toHaveBeenCalledTimes(1);
    thirdDaemon.shutdown();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a provider lease released before the daemon stops is not recovered again', async () => {
  const stateDir = mkdtempForTestSync('agent-device-live-provider-lease-');
  const recoverExpiredLease = vi.fn(async (_lease: DeviceLease) => undefined);
  const options = { recoverExpiredLease, stateDir, recoverableProviderIds: ['revyl'] };
  const daemon = createExpiredProviderLeaseReleaser(options);
  const registry = new LeaseRegistry({
    onProviderLeasesChanged: (leases) => daemon.recordLiveLeases(leases),
  });
  try {
    const lease = registry.allocateLease({ tenantId: 't', runId: 'run-1', leaseProvider: 'revyl' });
    registry.releaseLease(leaseReleaseRequestFor(lease));
    daemon.shutdown();

    const restartedDaemon = createExpiredProviderLeaseReleaser(options);
    await restartedDaemon.recoverInherited();
    expect(recoverExpiredLease).not.toHaveBeenCalled();
    restartedDaemon.shutdown();
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('an expired lease stays journaled until its expired record is durable', async () => {
  const stateDir = mkdtempForTestSync('agent-device-live-provider-lease-');
  // A directory where the expired record goes makes every write of it fail.
  fs.mkdirSync(`${stateDir}/expired-provider-leases.json`);
  let now = 1_000;
  const recoverExpiredLease = vi.fn(async (_lease: DeviceLease) => undefined);
  const daemon = createExpiredProviderLeaseReleaser({
    recoverExpiredLease,
    stateDir,
    recoverableProviderIds: ['revyl'],
  });
  const registry = new LeaseRegistry({
    defaultLeaseTtlMs: 10,
    minLeaseTtlMs: 1,
    now: () => now,
    onLeaseExpired: (lease) => void daemon.release(lease),
    onProviderLeasesChanged: (leases) => daemon.recordLiveLeases(leases),
  });
  try {
    const lease = registry.allocateLease({ tenantId: 't', runId: 'run-1', leaseProvider: 'revyl' });
    now = 1_011;
    registry.consumeExpiredLease(lease.leaseId);

    const journal = JSON.parse(fs.readFileSync(`${stateDir}/live-provider-leases.json`, 'utf8'));
    expect(journal.leases.map((entry: DeviceLease) => entry.leaseId)).toEqual([lease.leaseId]);
    expect(recoverExpiredLease).not.toHaveBeenCalled();
  } finally {
    daemon.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a journal write that fails is retried with the latest leases', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-live-provider-lease-');
  const journalPath = `${stateDir}/live-provider-leases.json`;
  fs.mkdirSync(journalPath);
  const daemon = createExpiredProviderLeaseReleaser({
    recoverExpiredLease: async () => undefined,
    stateDir,
    recoverableProviderIds: ['revyl'],
    retryDelayMs: 10,
  });
  const registry = new LeaseRegistry({
    onProviderLeasesChanged: (leases) => daemon.recordLiveLeases(leases),
  });
  try {
    const first = registry.allocateLease({ tenantId: 't', runId: 'run-1', leaseProvider: 'revyl' });
    // A second lease arrives while writes still fail, so the retry must write the latest set.
    const second = registry.allocateLease({
      tenantId: 't',
      runId: 'run-2',
      leaseProvider: 'revyl',
    });
    expect(fs.statSync(journalPath).isDirectory()).toBe(true);

    fs.rmdirSync(journalPath);
    await vi.advanceTimersByTimeAsync(10);
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(journal.leases.map((entry: DeviceLease) => entry.leaseId).sort()).toEqual(
      [first.leaseId, second.leaseId].sort(),
    );
  } finally {
    daemon.shutdown();
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('shutdown makes the journal write a pending retry still owed', async () => {
  vi.useFakeTimers();
  const stateDir = mkdtempForTestSync('agent-device-live-provider-lease-');
  const journalPath = `${stateDir}/live-provider-leases.json`;
  fs.mkdirSync(journalPath);
  const daemon = createExpiredProviderLeaseReleaser({
    recoverExpiredLease: async () => undefined,
    stateDir,
    recoverableProviderIds: ['revyl'],
    retryDelayMs: 60_000,
  });
  const registry = new LeaseRegistry({
    onProviderLeasesChanged: (leases) => daemon.recordLiveLeases(leases),
  });
  try {
    const lease = registry.allocateLease({ tenantId: 't', runId: 'run-1', leaseProvider: 'revyl' });
    fs.rmdirSync(journalPath);
    // The retry is a minute away; shutdown must not leave the journal unwritten until then.
    daemon.shutdown();
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    expect(journal.leases.map((entry: DeviceLease) => entry.leaseId)).toEqual([lease.leaseId]);
  } finally {
    vi.useRealTimers();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('adopted leases whose record is not durable stay journaled through later journal writes', async () => {
  const stateDir = mkdtempForTestSync('agent-device-live-provider-lease-');
  const options = {
    recoverExpiredLease: async () => undefined,
    stateDir,
    recoverableProviderIds: ['revyl'],
  };
  const killedDaemon = createExpiredProviderLeaseReleaser(options);
  const registry = new LeaseRegistry({
    onProviderLeasesChanged: (leases) => killedDaemon.recordLiveLeases(leases),
  });
  const orphan = registry.allocateLease({ tenantId: 't', runId: 'run-1', leaseProvider: 'revyl' });
  killedDaemon.shutdown();
  // The expired record cannot be written, so adoption keeps the leases only in memory and the journal.
  fs.mkdirSync(`${stateDir}/expired-provider-leases.json`);
  const restarted = createExpiredProviderLeaseReleaser({
    ...options,
    recoverExpiredLease: () => new Promise<void>(() => {}),
  });
  try {
    void restarted.recoverInherited();
    // The new daemon's registry is empty, so this journal write has no live leases of its own.
    restarted.recordLiveLeases([]);
    const journal = JSON.parse(fs.readFileSync(`${stateDir}/live-provider-leases.json`, 'utf8'));
    expect(journal.leases.map((entry: DeviceLease) => entry.leaseId)).toEqual([orphan.leaseId]);
  } finally {
    restarted.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('a daemon refused the registration leaves the live journal byte-identical and recovers nothing', async () => {
  const stateDir = mkdtempForTestSync('agent-device-live-provider-lease-');
  const recoverExpiredLease = vi.fn(async (_lease: DeviceLease) => undefined);
  const options = { recoverExpiredLease, stateDir, recoverableProviderIds: ['revyl'] };
  const runningDaemon = createExpiredProviderLeaseReleaser(options);
  const registry = new LeaseRegistry({
    onProviderLeasesChanged: (leases) => runningDaemon.recordLiveLeases(leases),
  });
  try {
    registry.allocateLease({ tenantId: 't', runId: 'run-1', leaseProvider: 'revyl' });
    const journalBefore = fs.readFileSync(`${stateDir}/live-provider-leases.json`);
    // A second daemon on the same state directory is built, then refused the registration: it never
    // reaches `recoverInherited`, and nothing it does before that may touch the live daemon's records.
    const refusedDaemon = createExpiredProviderLeaseReleaser(options);
    await refusedDaemon.retryPending();
    refusedDaemon.shutdown();

    expect(recoverExpiredLease).not.toHaveBeenCalled();
    expect(fs.readFileSync(`${stateDir}/live-provider-leases.json`)).toEqual(journalBefore);
    expect(fs.existsSync(`${stateDir}/expired-provider-leases.json`)).toBe(false);
  } finally {
    runningDaemon.shutdown();
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('daemon startup recovers inherited lease records only after it holds the registration', () => {
  const source = fs.readFileSync(new URL('../http/daemon-runtime.ts', import.meta.url), 'utf8');
  const refused = source.indexOf("reason: 'daemon_registration_refused'");
  const recovery = source.indexOf('.recoverInherited(');

  expect(refused).toBeGreaterThanOrEqual(0);
  expect(recovery).toBeGreaterThan(refused);
  expect(source.indexOf('expiredProviderLeaseReleaser.retryPending()')).toBe(-1);
});
