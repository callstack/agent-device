import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  abandonDeviceClaim,
  acquireDeviceClaim as acquireProductionDeviceClaim,
  clearDeviceClaim,
  processOwnsActiveDeviceClaim,
  releaseProvenStaleDeviceClaims,
} from '../device-claims.ts';
import { canonicalLocalDeviceKey } from '../device-claim-paths.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';
import { publishDaemonRegistration } from '../../__tests__/test-utils/device-claim-store.ts';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { acquireProcessLock } from '@agent-device/host-kit/file';

vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('../../__tests__/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(
    importOriginal,
  ),
);

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
    device,
    session: 'first',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.equal(first.status, 'acquired');
  const persisted = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  assert.equal(persisted.schemaVersion, 2);
  assert.deepEqual(persisted.device, {
    id: device.id,
    family: device.platform,
    kind: device.kind,
    name: device.name,
  });
  const second = await acquireDeviceClaim({
    device,
    session: 'second',
    workspace: '/worktrees/second',
    stateDir: root,
  });
  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.session, 'first');
});

test('does not treat a same-named session in another worktree as its claim owner', async () => {
  const root = useClaimsRoot();
  const first = await acquireDeviceClaim({
    device,
    session: 'default',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.equal(first.status, 'acquired');
  const second = await acquireDeviceClaim({
    device,
    session: 'default',
    workspace: '/worktrees/second',
    stateDir: path.join(root, 'second-state'),
  });
  assert.equal(second.status, 'conflict');
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.workspace, '/worktrees/first');
});

test('reconciles a proven-dead owner and replaces it while acquiring the same claim', async () => {
  const root = useClaimsRoot();
  const first = await acquireDeviceClaim({
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
    device,
    session: 'replacement',
    workspace: '/worktrees/replacement',
    stateDir: root,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'acquired');
  assert.equal(reconciledSession, 'dead-owner');
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.session, 'replacement');
});

test('retains a proven-dead claim when exact-owner cleanup remains pending', async () => {
  const root = useClaimsRoot();
  await acquireDeviceClaim({
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
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.session, 'cleanup-pending');
});

test('PID reuse is uncertain ownership and never authorizes reconciliation', async () => {
  const root = useClaimsRoot();
  await acquireDeviceClaim({
    device,
    session: 'reused-pid-owner',
    workspace: '/worktrees/old',
    stateDir: root,
  });
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(claimPath(root), JSON.stringify({ ...stored, ownerStartTime: 'other-start' }));
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const result = await acquireDeviceClaim({
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
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.session, 'reused-pid-owner');
});

test('an internally inconsistent dead claim never authorizes reconciliation', async () => {
  const root = useClaimsRoot();
  await acquireDeviceClaim({
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

test('clears only the exact owner token and identity, never a successor claim', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'first',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerToken: 'successor-token', session: 'second' }),
  );
  // Resolving is not releasing: the outcome is what a caller reporting
  // ownership must read, since the successor's claim is deliberately kept.
  assert.equal(await clearDeviceClaim(acquired.ownership), 'ownership-changed');
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.session, 'second');
});

test('reports the exact outcome of clearing an owned, missing, and unowned claim', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'owner',
    workspace: '/worktrees/owner',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;

  assert.equal(await clearDeviceClaim(acquired.ownership), 'deleted');
  assert.equal(await clearDeviceClaim(acquired.ownership), 'absent');
  assert.equal(await clearDeviceClaim(undefined), 'absent');
});

test('keeps corrupt records visible and classifies dead owners without reclaiming either', () => {
  const root = useClaimsRoot();
  fs.writeFileSync(path.join(root, 'corrupt.json'), '{bad json');
  fs.writeFileSync(
    path.join(root, 'dead.json'),
    JSON.stringify({
      schemaVersion: 1,
      deviceKey: 'local:android:none:dead',
      device: { platform: 'android', id: 'dead', name: 'Dead', kind: 'emulator' },
      session: 'dead-owner',
      workspace: '/worktrees/dead',
      stateDir: root,
      ownerPid: 999_999_999,
      ownerStartTime: 'old-start',
      ownerToken: 'opaque-token',
      createdAtMs: 1,
      updatedAtMs: 1,
    }),
  );
  const claims = inspectDeviceClaims({});
  assert.equal(
    claims.find((claim) => claim.fileName === 'corrupt.json')?.classification,
    'inconsistent',
  );
  assert.equal(
    claims.find((claim) => claim.fileName === 'dead.json')?.classification,
    'owner-process-dead',
  );
  assert.equal(fs.existsSync(path.join(root, 'corrupt.json')), true);
  assert.equal(fs.existsSync(path.join(root, 'dead.json')), true);
});

test('fails closed when claim inspection encounters a permission or transient I/O failure', () => {
  useClaimsRoot();
  vi.spyOn(fs, 'readdirSync').mockImplementation(() => {
    const error = new Error('permission denied') as NodeJS.ErrnoException;
    error.code = 'EACCES';
    throw error;
  });
  const claims = inspectDeviceClaims({});
  assert.equal(claims[0]?.classification, 'unknown');
});

test('classifies transient claim-file read errors as unknown, not inconsistent', () => {
  const root = useClaimsRoot();
  fs.writeFileSync(path.join(root, 'transient.json'), '{}');
  vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
    const error = new Error('I/O error') as NodeJS.ErrnoException;
    error.code = 'EIO';
    throw error;
  });
  const claims = inspectDeviceClaims({});
  assert.equal(claims[0]?.classification, 'unknown');
});

test('matches public Apple claim records through the shared platform selector semantics', async () => {
  const root = useClaimsRoot();
  await acquireDeviceClaim({
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'ios-claim',
      name: 'iPhone',
      kind: 'simulator',
      booted: true,
    },
    session: 'ios',
    workspace: process.cwd(),
    stateDir: root,
  });
  assert.equal(inspectDeviceClaims({ platform: 'apple' }).length, 1);
  assert.equal(inspectDeviceClaims({ platform: 'ios' }).length, 1);
  assert.equal(inspectDeviceClaims({ platform: 'macos' }).length, 0);
});

test('canonicalizes legacy Apple devices without an explicit OS before persisting', async () => {
  const root = useClaimsRoot();
  const legacyAppleDevice: DeviceInfo = {
    platform: 'apple',
    id: 'legacy-ios-claim',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
  };
  const acquired = await acquireDeviceClaim({
    device: legacyAppleDevice,
    session: 'legacy-ios',
    workspace: process.cwd(),
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  const inspected = inspectDeviceClaims({ udid: legacyAppleDevice.id })[0];
  assert.equal(inspected?.classification, 'live');
  assert.equal(inspected?.claim?.device.appleOs, 'ios');
  assert.equal(inspected?.deviceKey, 'local:apple:ios:legacy-ios-claim');
});

test.each([
  device,
  {
    platform: 'apple' as const,
    appleOs: 'ios' as const,
    id: 'ios-local-claim',
    name: 'iPhone',
    kind: 'simulator' as const,
    booted: true,
  },
])(
  'enforces foreign ownership through the neutral local claim seam for $platform',
  async (target) => {
    const root = useClaimsRoot();
    await acquireDeviceClaim({
      device: target,
      session: 'first',
      workspace: '/worktrees/first',
      stateDir: root,
    });

    const second = await acquireDeviceClaim({
      device: target,
      session: 'second',
      workspace: '/worktrees/second',
      stateDir: root,
    });

    assert.equal(second.status, 'conflict');
    if (second.status !== 'conflict') return;
    assert.equal(second.conflict.classification, 'live');
  },
);

/**
 * A live owner that is not this process. The mocked host-process module reads a
 * start time only for our own pid, so a claim recorded against our parent is a
 * genuinely-alive foreign owner — what a running daemon looks like on disk.
 */
function rewriteClaimOwner(root: string, ownerPid: number): void {
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(claimPath(root), JSON.stringify({ ...stored, ownerPid, ownerStartTime: null }));
}

async function seedForeignLiveClaim(root: string, stateDir: string): Promise<void> {
  fs.mkdirSync(stateDir, { recursive: true });
  const seeded = await acquireDeviceClaim({
    device,
    session: 'cwd:/w:default',
    workspace: '/w',
    stateDir,
  });
  assert.equal(seeded.status, 'acquired');
  rewriteClaimOwner(root, process.ppid);
}

test('reconciles a live claim whose owner is no longer the daemon published for its state dir', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'orphaned-state');
  await seedForeignLiveClaim(root, stateDir);
  // #2031: the recorded owner is a replaced-but-still-running daemon. We are the
  // successor published for the same state dir, so its session is absent from
  // `session list` and no close can ever reach it.
  publishDaemonRegistration(stateDir, readCurrentOwnerIdentity());
  let reconciledSession: string | undefined;
  const reconcile = vi.fn(async (claim: { session: string }) => {
    reconciledSession = claim.session;
    return { status: 'reconciled' as const };
  });

  const second = await acquireDeviceClaim({
    device,
    session: 'cwd:/w:default',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'acquired');
  assert.equal(reconciledSession, 'cwd:/w:default');
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.ownerPid, process.pid);
});

test('keeps a live claim blocking while its owner is still the daemon published for its state dir', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'served-state');
  await seedForeignLiveClaim(root, stateDir);
  publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const second = await acquireDeviceClaim({
    device,
    session: 'other',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(reconcile.mock.calls.length, 0);
});

test('never supersedes a live claim owner on a state dir with no published daemon', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'unpublished-state');
  await seedForeignLiveClaim(root, stateDir);
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const second = await acquireDeviceClaim({
    device,
    session: 'other',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(reconcile.mock.calls.length, 0);
});

test('never treats a claim owned by the inspecting process as superseded', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'self-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const first = await acquireDeviceClaim({
    device,
    session: 'ours',
    workspace: '/w',
    stateDir,
  });
  assert.equal(first.status, 'acquired');
  // A registration naming someone else cannot make us unreachable: a caller had
  // to reach this process to ask, so our own sessions stay closeable.
  publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: 'other-start' });
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const second = await acquireDeviceClaim({
    device,
    session: 'another',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(reconcile.mock.calls.length, 0);
});

test('an abandoned claim yields to the next acquire of the daemon that abandoned it', async () => {
  const root = useClaimsRoot();
  const aborted = await acquireDeviceClaim({
    device,
    session: 'attempt-1',
    workspace: '/worktrees/suite',
    stateDir: root,
  });
  assert.equal(aborted.status, 'acquired');
  if (aborted.status !== 'acquired') return;
  assert.equal(await abandonDeviceClaim(aborted.ownership), 'abandoned');
  assert.equal(
    typeof inspectDeviceClaims({ serial: device.id })[0]?.claim?.abandonedAtMs,
    'number',
  );
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const retry = await acquireDeviceClaim({
    device,
    session: 'attempt-2',
    workspace: '/worktrees/suite',
    stateDir: root,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(retry.status, 'acquired');
  const claim = inspectDeviceClaims({ serial: device.id })[0]?.claim;
  assert.equal(claim?.session, 'attempt-2');
  assert.equal(claim?.abandonedAtMs, undefined);
  // Abandonment is an owner's own record, not a proof about a dead owner: it never
  // routes through orphan reconciliation.
  assert.equal(reconcile.mock.calls.length, 0);
  assert.equal(await clearDeviceClaim(aborted.ownership), 'ownership-changed');
});

test('an abandoned claim keeps fencing a daemon that does not own it', async () => {
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'foreign-state');
  await seedForeignLiveClaim(root, stateDir);
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(claimPath(root), JSON.stringify({ ...stored, abandonedAtMs: 1 }));
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const second = await acquireDeviceClaim({
    device,
    session: 'other',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(second.conflict.claim?.session, 'cwd:/w:default');
  assert.equal(reconcile.mock.calls.length, 0);
});

test("an abandoned claim keeps fencing this process on another daemon's state dir", async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'attempt-1',
    workspace: '/worktrees/suite',
    stateDir: path.join(root, 'owner-state'),
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  assert.equal(await abandonDeviceClaim(acquired.ownership), 'abandoned');

  const second = await acquireDeviceClaim({
    device,
    session: 'attempt-2',
    workspace: '/worktrees/suite',
    stateDir: path.join(root, 'other-state'),
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.claim?.session, 'attempt-1');
});

test('reports the exact outcome of abandoning an owned, missing, and unowned claim', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'owner',
    workspace: '/worktrees/owner',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;

  assert.equal(await abandonDeviceClaim(acquired.ownership), 'abandoned');
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerToken: 'successor-token', session: 'successor' }),
  );
  assert.equal(await abandonDeviceClaim(acquired.ownership), 'ownership-changed');
  fs.rmSync(claimPath(root));
  assert.equal(await abandonDeviceClaim(acquired.ownership), 'absent');
  assert.equal(await abandonDeviceClaim(undefined), 'absent');
});

test('answers the runner authority probe only for a claim this process actively holds', async () => {
  const root = useClaimsRoot();
  assert.equal(processOwnsActiveDeviceClaim(device), false);

  const acquired = await acquireDeviceClaim({
    device,
    session: 'probe-owner',
    workspace: '/worktrees/probe',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  if (acquired.status !== 'acquired') return;
  assert.equal(processOwnsActiveDeviceClaim(device), true);
  assert.equal(processOwnsActiveDeviceClaim({ ...device, id: 'some-other-device' }), false);

  assert.equal(await abandonDeviceClaim(acquired.ownership), 'abandoned');
  assert.equal(processOwnsActiveDeviceClaim(device), false);
});

test('a same-id claim from another platform family grants no runner authority', async () => {
  const root = useClaimsRoot();
  // An Android claim whose serial happens to equal an Apple runner's device id
  // must not authorize destructive takeover of that runner: authority matches
  // the canonical family/OS/id key, never the bare id.
  const acquired = await acquireDeviceClaim({
    device,
    session: 'android-owner',
    workspace: '/worktrees/android',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  const sameIdAppleSimulator: DeviceInfo = {
    platform: 'apple',
    appleOs: 'ios',
    id: device.id,
    name: 'Colliding iPhone',
    kind: 'simulator',
    booted: true,
  };
  assert.equal(processOwnsActiveDeviceClaim(sameIdAppleSimulator), false);
  assert.equal(processOwnsActiveDeviceClaim(device), true);

  const appleAcquired = await acquireDeviceClaim({
    device: sameIdAppleSimulator,
    session: 'apple-owner',
    workspace: '/worktrees/apple',
    stateDir: root,
  });
  assert.equal(appleAcquired.status, 'acquired');
  assert.equal(processOwnsActiveDeviceClaim(sameIdAppleSimulator), true);
});

test('denies the runner authority probe for a claim held by another process', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'foreign-owner',
    workspace: '/worktrees/foreign',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerPid: 999_999, ownerStartTime: 'other-start' }),
  );
  assert.equal(processOwnsActiveDeviceClaim(device), false);
});

test('releases a provably dead owner through reconciliation and refuses everything else', async () => {
  const root = useClaimsRoot();
  const dead = await acquireDeviceClaim({
    device,
    session: 'dead-owner',
    workspace: '/worktrees/dead',
    stateDir: root,
  });
  assert.equal(dead.status, 'acquired');
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerPid: 999_999_999, ownerStartTime: 'old-start' }),
  );

  const reconciled: string[] = [];
  const outcomes = await releaseProvenStaleDeviceClaims({
    selectors: {},
    reconcile: async (claim) => {
      reconciled.push(claim.session);
      return { status: 'reconciled' };
    },
  });
  assert.deepEqual(reconciled, ['dead-owner']);
  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0]?.status, 'released');
  assert.equal(outcomes[0]?.session, 'dead-owner');
  assert.equal(fs.existsSync(claimPath(root)), false);
});

test('release retains the claim when reconciliation reports unsettled resources', async () => {
  const root = useClaimsRoot();
  const dead = await acquireDeviceClaim({
    device,
    session: 'retained-owner',
    workspace: '/worktrees/retained',
    stateDir: root,
  });
  assert.equal(dead.status, 'acquired');
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerPid: 999_999_999, ownerStartTime: 'old-start' }),
  );

  const outcomes = await releaseProvenStaleDeviceClaims({
    selectors: {},
    reconcile: async () => ({ status: 'retained', reason: 'screen-recording-cleanup-pending' }),
  });
  assert.equal(outcomes[0]?.status, 'retained');
  assert.equal(outcomes[0]?.reason, 'screen-recording-cleanup-pending');
  assert.equal(fs.existsSync(claimPath(root)), true);
});

test('release refuses live owners and corrupt claims without touching them', async () => {
  const root = useClaimsRoot();
  const live = await acquireDeviceClaim({
    device,
    session: 'live-owner',
    workspace: '/worktrees/live',
    stateDir: root,
  });
  assert.equal(live.status, 'acquired');
  fs.writeFileSync(path.join(root, 'corrupt.json'), '{not json');

  const reconciled: string[] = [];
  const outcomes = await releaseProvenStaleDeviceClaims({
    selectors: {},
    reconcile: async (claim) => {
      reconciled.push(claim.session);
      return { status: 'reconciled' };
    },
  });
  assert.deepEqual(reconciled, []);
  assert.equal(outcomes.length, 2);
  const byStatus = new Map(outcomes.map((outcome) => [outcome.reason, outcome.status]));
  assert.equal(byStatus.get('live-owner'), 'refused');
  assert.equal(byStatus.get('claim-record-inconsistent'), 'refused');
  assert.equal(fs.existsSync(claimPath(root)), true);
  assert.equal(fs.existsSync(path.join(root, 'corrupt.json')), true);
});

test('release names the exact refusal for uncertain owners and misnamed claim files', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'reused-owner',
    workspace: '/worktrees/reused',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  // Same PID, different recorded start time: PID reuse, uncertain ownership.
  fs.writeFileSync(claimPath(root), JSON.stringify({ ...stored, ownerStartTime: 'other-start' }));
  // A dead-owner claim stored under a name that is not the hash of its own
  // device key: the claim lock protects a different path, so release refuses.
  fs.writeFileSync(
    path.join(root, 'misnamed.json'),
    JSON.stringify({
      ...stored,
      deviceKey: 'local:android:none:misnamed-device',
      device: { ...(stored.device as object), id: 'misnamed-device' },
      ownerPid: 999_999_999,
      ownerStartTime: 'long-gone',
      session: 'misnamed-owner',
    }),
  );

  const outcomes = await releaseProvenStaleDeviceClaims({
    selectors: {},
    reconcile: async () => ({ status: 'reconciled' }),
  });
  const reasons = new Map(outcomes.map((outcome) => [outcome.session, outcome.reason]));
  assert.equal(reasons.get('reused-owner'), 'owner-pid-reused');
  assert.equal(reasons.get('misnamed-owner'), 'claim-file-name-mismatch');
  assert.ok(outcomes.every((outcome) => outcome.status === 'refused'));
  assert.equal(fs.existsSync(path.join(root, 'misnamed.json')), true);
});

test('release refuses a live process whose state dir is gone', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'dir-gone-owner',
    workspace: '/worktrees/dir-gone',
    stateDir: path.join(root, 'missing-state-dir'),
  });
  assert.equal(acquired.status, 'acquired');

  const outcomes = await releaseProvenStaleDeviceClaims({
    selectors: {},
    reconcile: async () => ({ status: 'reconciled' }),
  });
  assert.equal(outcomes[0]?.status, 'refused');
  assert.equal(outcomes[0]?.reason, 'owner-process-still-running');
  assert.equal(fs.existsSync(claimPath(root)), true);
});

test('release reports changed when the claim is replaced between scan and lock acquisition', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireDeviceClaim({
    device,
    session: 'raced-owner',
    workspace: '/worktrees/raced',
    stateDir: root,
  });
  assert.equal(acquired.status, 'acquired');
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerPid: 999_999_999, ownerStartTime: 'long-gone' }),
  );

  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));
  // Owner start time stays null: the pinned test start time diverges from the
  // real one the lock's liveness probe reads, which would classify this held
  // lock as PID-reused and let the release steal it.
  const releaseLock = await acquireProcessLock({
    lockDirPath: `${claimPath(root)}.lock`,
    owner: { pid: process.pid, startTime: null, acquiredAtMs: Date.now() },
    timeoutMs: 5_000,
    description: 'test-held device claim lock',
  });
  let outcomes: Awaited<ReturnType<typeof releaseProvenStaleDeviceClaims>> = [];
  let releaseSettled = false;
  const release = releaseProvenStaleDeviceClaims({ selectors: {}, reconcile }).then((result) => {
    outcomes = result;
    releaseSettled = true;
  });
  // The scan has run; the per-claim transaction is now waiting on the lock this
  // test holds. Replace the claim with a successor before letting it in.
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(releaseSettled, false);
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({
      ...stored,
      ownerPid: 999_999_999,
      ownerStartTime: 'long-gone',
      ownerToken: 'successor-token',
      session: 'successor-session',
    }),
  );
  await releaseLock();
  await release;

  assert.equal(outcomes[0]?.status, 'changed');
  assert.equal(reconcile.mock.calls.length, 0);
  const remaining = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  assert.equal(remaining.ownerToken, 'successor-token');
});
