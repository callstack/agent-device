import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  acquireDeviceClaim as acquireProductionDeviceClaim,
  clearDeviceClaim,
} from '../device-claims.ts';
import { canonicalLocalDeviceKey } from '../device-claim-paths.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../utils/host-process.ts', async (importOriginal) =>
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
