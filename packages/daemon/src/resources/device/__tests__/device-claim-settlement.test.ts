import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import * as hostProcess from '@agent-device/host-kit/process';
import {
  acquireDeviceClaim as acquireProductionDeviceClaim,
  acquireTransientDeviceClaim,
  canonicalLocalDeviceKey,
  inspectDeviceClaims,
  renewDeviceClaim,
} from '@agent-device/daemon-contracts/device-claims';
import type { DeviceBootObservationService } from '@agent-device/contracts/device-boot';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  mkdtempForTestSync,
  pinOwnProcessStartTime,
  publishDaemonRegistration,
} from '@agent-device/test-kit';
pinOwnProcessStartTime(hostProcess);

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const roots: string[] = [];

function acquireDeviceClaim(
  params: Omit<
    Parameters<typeof acquireProductionDeviceClaim>[0],
    'reconcileOrphanedDeviceClaim'
  > & {
    reconcileOrphanedDeviceClaim?: Parameters<
      typeof acquireProductionDeviceClaim
    >[0]['reconcileOrphanedDeviceClaim'];
  },
) {
  return acquireProductionDeviceClaim({
    ...params,
    reconcileOrphanedDeviceClaim:
      params.reconcileOrphanedDeviceClaim ??
      (async () => ({ status: 'retained', reason: 'test-no-recovery' })),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function useClaimsRoot(): string {
  const root = mkdtempForTestSync('agent-device-claims-');
  roots.push(root);
  process.env.AGENT_DEVICE_CLAIMS_DIR = root;
  return root;
}

function claimPath(root: string): string {
  const key = canonicalLocalDeviceKey(device);
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(root, `${hash}.json`);
}

test('preserves and reports a live foreign claim without overwriting it', async () => {
  const root = useClaimsRoot();
  const first = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'first',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.equal(first.status, 'acquired');
  const persisted = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 3);
  assert.deepEqual(persisted.device, {
    id: device.id,
    family: device.platform,
    kind: device.kind,
    name: device.name,
  });
  const second = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'second',
    workspace: '/worktrees/second',
    stateDir: root,
  });
  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(inspectDeviceClaims({ serial: device.id }, process.env)[0]?.claim?.session, 'first');
});

// The maintainer's trace on #3714: `install` holds a transient claim under the label
// `transient:install`; an `open` from the same workspace addressed at that label must not be
// handed the command's ownership token. Any session string can be typed into `--session`; only
// the stored kind says who holds the claim, so an open-session acquirer never holds a
// transient-command record and vice versa.
test('an open session addressed at a command label never adopts the in-flight command claim', async () => {
  const root = useClaimsRoot();
  const holder = await acquireTransientDeviceClaim({
    env: process.env,
    device,
    command: 'install',
    coveredBySession: 'open-a',
    coveredClaimIsOwnedByRequest: () => false,
    workspace: '/worktrees/first',
    stateDir: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
  assert.equal(holder.status, 'acquired');
  if (holder.status !== 'acquired') return;

  const open = await acquireDeviceClaim({
    device,
    session: 'transient:install',
    workspace: '/worktrees/first',
    stateDir: root,
    env: process.env,
  });

  assert.equal(open.status, 'conflict');
  if (open.status !== 'conflict') return;
  assert.equal(open.conflict.classification, 'live');
  // The refusal wrote nothing: the command still holds the device with its own token.
  assert.equal(storedClaim().ownerToken, holder.ownership.ownerToken);
});

// The mirror direction, pinned at the settlement boundary every acquire route goes through. Two
// live requests can never share one claim: a second `reinstall` or `install` reaching the running
// `install`'s claim — same workspace, label as session — is refused, and only the request that
// took the claim re-enters it, through the token the admission layer already pins.
test('a second request never holds an in-flight command claim, under its own label or another’s', async () => {
  const root = useClaimsRoot();
  const holder = await acquireTransientDeviceClaim({
    env: process.env,
    device,
    command: 'install',
    coveredBySession: 'open-a',
    coveredClaimIsOwnedByRequest: () => false,
    workspace: '/worktrees/first',
    stateDir: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
  assert.equal(holder.status, 'acquired');
  if (holder.status !== 'acquired') return;

  const intruder = await acquireTransientDeviceClaim({
    env: process.env,
    device,
    command: 'reinstall',
    coveredBySession: 'transient:install',
    coveredClaimIsOwnedByRequest: () => true,
    workspace: '/worktrees/first',
    stateDir: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
  assert.equal(intruder.status, 'conflict');
  assert.equal(storedClaim().ownerToken, holder.ownership.ownerToken);

  const sameCommand = await acquireTransientDeviceClaim({
    env: process.env,
    device,
    command: 'install',
    coveredBySession: 'some-other-session',
    coveredClaimIsOwnedByRequest: () => false,
    workspace: '/worktrees/first',
    stateDir: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
  // A different request of the SAME command still refuses: only the request holding the claim's
  // release token re-enters it (the admission layer pins that), so a live command claim is never
  // disposed from under its holder by a second same-named request.
  assert.equal(sameCommand.status, 'conflict');
  assert.equal(storedClaim().ownerToken, holder.ownership.ownerToken);
});

// A migrated record states no kind, so no acquirer's kind can equal it: even the same principal
// in the same workspace cannot hold it at acquisition, and a record whose start time is unreadable
// (`null === null` against this process) is the case that most needs the refusal. Acquisition
// never renews it either — the token the record itself names is the only renewal route left.
test('a migrated record states no kind, so acquisition never holds it', async () => {
  for (const startTimeUnavailable of [false, true]) {
    const root = useClaimsRoot();
    const identity = startTimeUnavailable
      ? { pid: process.pid, startTime: null }
      : hostProcess.readCurrentOwnerIdentity();
    const owner = vi.spyOn(hostProcess, 'readCurrentOwnerIdentity').mockReturnValue(identity);
    try {
      fs.writeFileSync(
        claimPath(root),
        JSON.stringify({
          schemaVersion: 2,
          deviceKey: canonicalLocalDeviceKey(device),
          device: { family: 'android', id: device.id, name: device.name, kind: device.kind },
          session: 'legacy-owner',
          workspace: '/worktrees/legacy',
          stateDir: root,
          ownerPid: identity.pid,
          ownerStartTime: identity.startTime,
          ownerToken: 'legacy-token',
          createdAtMs: 1,
          updatedAtMs: 1,
        }),
      );

      const held = await acquireDeviceClaim({
        device,
        session: 'legacy-owner',
        workspace: '/worktrees/legacy',
        stateDir: root,
        env: process.env,
      });

      assert.equal(held.status, 'conflict');
      assert.equal(storedClaim().ownerToken, 'legacy-token');
      assert.equal(storedClaim().updatedAtMs, 1);
    } finally {
      owner.mockRestore();
    }
  }
});

// Renewal, abandon, and clear write a decoded claim back. A migrated record must therefore carry
// the current schema version: a legacy version on the migrated device shape reads back as
// inconsistent and locks the device out of any settlement path that reads it.
test('a renewal through a migrated record’s own token writes back the shape the reader expects', async () => {
  const root = useClaimsRoot();
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: canonicalLocalDeviceKey(device),
      device: { platform: 'android', id: device.id, name: device.name, kind: device.kind },
      session: 'legacy-owner',
      workspace: '/worktrees/legacy',
      stateDir: root,
      ownerPid: process.pid,
      ownerStartTime: 'test-process-start-time',
      ownerToken: 'legacy-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );

  const renewal = await renewDeviceClaim(
    {
      deviceKey: canonicalLocalDeviceKey(device),
      ownerToken: 'legacy-token',
      ownerPid: process.pid,
      ownerStartTime: 'test-process-start-time',
    },
    process.env,
  );
  assert.equal(renewal.status, 'renewed');

  const persisted = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 3);
  const reread = inspectDeviceClaims({ serial: device.id }, process.env)[0];
  assert.equal(reread?.classification, 'live');
  assert.equal(reread?.claim?.session, 'legacy-owner');
  assert.equal(reread?.claim?.claimOwnerKind, 'unstated');
});

test('does not treat a same-named session in another worktree as its claim owner', async () => {
  const root = useClaimsRoot();
  const first = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'default',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.equal(first.status, 'acquired');
  const second = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'default',
    workspace: '/worktrees/second',
    stateDir: path.join(root, 'second-state'),
  });
  assert.equal(second.status, 'conflict');
  assert.equal(
    inspectDeviceClaims({ serial: device.id }, process.env)[0]?.claim?.workspace,
    '/worktrees/first',
  );
});

test('reconciles a proven-dead owner and replaces it while acquiring the same claim', async () => {
  const root = useClaimsRoot();
  const first = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'dead-owner',
    workspace: '/worktrees/dead',
    stateDir: root,
  });
  assert.equal(first.status, 'acquired');
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerPid: 999_999_999, ownerStartTime: 'dead-start' }),
  );
  let reconciledSession: string | undefined;
  const reconcile = vi.fn(async (claim: { session: string }) => {
    reconciledSession = claim.session;
    return { status: 'reconciled' as const };
  });

  const second = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'replacement',
    workspace: '/worktrees/replacement',
    stateDir: root,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'acquired');
  assert.equal(reconciledSession, 'dead-owner');
  assert.equal(
    inspectDeviceClaims({ serial: device.id }, process.env)[0]?.claim?.session,
    'replacement',
  );
});

test('retains a proven-dead claim when exact-owner cleanup remains pending', async () => {
  const root = useClaimsRoot();
  await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'cleanup-pending',
    workspace: '/worktrees/dead',
    stateDir: root,
  });
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerPid: 999_999_999, ownerStartTime: 'dead-start' }),
  );

  const second = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'blocked',
    workspace: '/worktrees/blocked',
    stateDir: root,
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained',
      reason: 'cleanup-pending',
    }),
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'owner-process-dead');
  assert.equal(
    inspectDeviceClaims({ serial: device.id }, process.env)[0]?.claim?.session,
    'cleanup-pending',
  );
});

test('PID reuse is uncertain ownership and never authorizes reconciliation', async () => {
  const root = useClaimsRoot();
  await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'reused-pid-owner',
    workspace: '/worktrees/old',
    stateDir: root,
  });
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(claimPath(root), JSON.stringify({ ...stored, ownerStartTime: 'other-start' }));
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const result = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'blocked',
    workspace: '/worktrees/new',
    stateDir: root,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(result.status, 'conflict');
  if (result.status !== 'conflict') return;
  assert.equal(result.conflict.classification, 'owner-process-reused');
  assert.equal(reconcile.mock.calls.length, 0);
  assert.equal(
    inspectDeviceClaims({ serial: device.id }, process.env)[0]?.claim?.session,
    'reused-pid-owner',
  );
});

test('an internally inconsistent dead claim never authorizes reconciliation', async () => {
  const root = useClaimsRoot();
  await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'inconsistent-owner',
    workspace: '/worktrees/old',
    stateDir: root,
  });
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({
      ...stored,
      device: { platform: 'android', id: 'different-device', name: 'Other', kind: 'emulator' },
      ownerPid: 999_999_999,
      ownerStartTime: 'dead-start',
    }),
  );
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const result = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'blocked',
    workspace: '/worktrees/new',
    stateDir: root,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(result.status, 'conflict');
  if (result.status !== 'conflict') return;
  assert.equal(result.conflict.classification, 'inconsistent');
  assert.equal(reconcile.mock.calls.length, 0);
  assert.equal(fs.existsSync(claimPath(root)), true);
});

const reconciled = async () => ({ status: 'reconciled' as const });

function storedClaim() {
  const claim = inspectDeviceClaims({ serial: device.id }, process.env)[0]?.claim;
  assert.ok(claim);
  return claim;
}

function rewriteClaimOwner(root: string, ownerPid: number): void {
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(claimPath(root), JSON.stringify({ ...stored, ownerPid, ownerStartTime: null }));
}

/** The claim as this process wrote it, but held by another live process from another state dir. */
async function seedForeignLiveClaim(root: string, stateDir: string): Promise<void> {
  fs.mkdirSync(stateDir, { recursive: true });
  const seeded = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'cwd:/w:default',
    workspace: '/w',
    stateDir,
  });
  assert.equal(seeded.status, 'acquired');
  rewriteClaimOwner(root, process.ppid);
}

function observesDeviceBootAt(bootedAtMs: number): DeviceBootObservationService {
  return { observeBootTimeMs: async () => ({ observed: true, bootedAtMs }) };
}

const UNOBSERVED_BOOT: DeviceBootObservationService = {
  observeBootTimeMs: async () => ({ observed: false, reason: 'unobserved' }),
};

// #2538: a claim that predates the device's current boot cannot describe live device-side ownership
// — the reboot destroyed the app process, the runner, and the accessibility connection — so it loses
// the device even while its recorded owner's process looks healthy from the host.
test('takes a live foreign claim whose device rebooted after the claim was taken', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'owner-state');
  await seedForeignLiveClaim(root, stateDir);
  publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });
  const bootedAtMs = storedClaim().createdAtMs + 1;
  let reconciledSession: string | undefined;

  const second = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'other',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: async (claim) => {
      reconciledSession = claim.session;
      return { status: 'reconciled' as const };
    },
    observeDeviceBoot: observesDeviceBootAt(bootedAtMs),
  });

  assert.equal(second.status, 'acquired');
  if (second.status !== 'acquired') return;
  assert.deepEqual(second.tookOver, {
    session: 'cwd:/w:default',
    workspace: '/w',
    stateDir,
    bootedAtMs,
  });
  assert.equal(reconciledSession, 'cwd:/w:default');
  assert.equal(storedClaim().session, 'other');
});

test('keeps a live foreign claim blocking until the device boot is answered', async () => {
  for (const observeDeviceBoot of [UNOBSERVED_BOOT, undefined]) {
    const root = useClaimsRoot();
    const stateDir = path.join(root, 'unobserved-state');
    await seedForeignLiveClaim(root, stateDir);
    publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });

    const second = await acquireDeviceClaim({
      env: process.env,
      device,
      session: 'other',
      workspace: '/w',
      stateDir,
      reconcileOrphanedDeviceClaim: reconciled,
      ...(observeDeviceBoot ? { observeDeviceBoot } : {}),
    });

    assert.equal(second.status, 'conflict');
    if (second.status !== 'conflict') return;
    assert.equal(second.conflict.classification, 'live');
    assert.equal(storedClaim().session, 'cwd:/w:default');
  }
});

test('a boot that predates the claim proves nothing about it and keeps the conflict', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'pre-claim-boot-state');
  await seedForeignLiveClaim(root, stateDir);
  publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });

  const second = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'other',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconciled,
    observeDeviceBoot: observesDeviceBootAt(storedClaim().createdAtMs),
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
});

test('a rebooted device stays claimed while its owner has resources left to settle', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'reboot-cleanup-state');
  await seedForeignLiveClaim(root, stateDir);
  publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });

  const second = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'other',
    workspace: '/w',
    stateDir,
    observeDeviceBoot: observesDeviceBootAt(storedClaim().createdAtMs + 1),
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(storedClaim().session, 'cwd:/w:default');
});

// The reboot bound is the last instant the owner vouched for the device, not the instant the claim
// was first written: an owner that came back on the rebooted device holds it against a later caller.
test('an owner that reopened its app after the reboot keeps the device', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'renewed-state');
  const first = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'cwd:/w:default',
    workspace: '/w',
    stateDir,
  });
  assert.equal(first.status, 'acquired');
  const bootedAtMs = storedClaim().createdAtMs + 1;
  await new Promise((resolve) => setTimeout(resolve, 2));

  const reopened = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'cwd:/w:default',
    workspace: '/w',
    stateDir,
    observeDeviceBoot: observesDeviceBootAt(bootedAtMs),
  });
  assert.equal(reopened.status, 'acquired');
  if (reopened.status !== 'acquired') return;
  assert.equal(reopened.tookOver, undefined);
  assert.ok(storedClaim().updatedAtMs >= bootedAtMs);

  rewriteClaimOwner(root, process.ppid);
  publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });
  const foreign = await acquireDeviceClaim({
    env: process.env,
    device,
    session: 'other',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconciled,
    observeDeviceBoot: observesDeviceBootAt(bootedAtMs),
  });

  assert.equal(foreign.status, 'conflict');
  if (foreign.status !== 'conflict') return;
  assert.equal(foreign.conflict.classification, 'live');
  assert.equal(storedClaim().session, 'cwd:/w:default');
});
