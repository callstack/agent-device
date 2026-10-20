import * as claimInspection from './device-claim-inspection.ts';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  abandonDeviceClaim,
  acquireDeviceClaim as acquireProductionDeviceClaim,
  acquireTransientDeviceClaim,
  releaseProvenStaleDeviceClaims,
} from './device-claims.ts';
import {
  appScopedDeviceKey,
  canonicalLocalDeviceKey,
  resolveDeviceClaimPath,
} from './device-claim-paths.ts';
import { inspectDeviceClaims } from './device-claim-inspection.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync, pinOwnProcessStartTime } from '@agent-device/test-kit';
import * as hostProcess from '@agent-device/host-kit/process';

pinOwnProcessStartTime(hostProcess);

const roots: string[] = [];

function acquireDeviceClaim(
  params: Omit<
    Parameters<typeof acquireProductionDeviceClaim>[0],
    'reconcileOrphanedDeviceClaim' | 'env'
  > & {
    reconcileOrphanedDeviceClaim?: Parameters<
      typeof acquireProductionDeviceClaim
    >[0]['reconcileOrphanedDeviceClaim'];
  },
) {
  return acquireProductionDeviceClaim({
    env: process.env,
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

const mac: DeviceInfo = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

/** Claims `mac` (or one of its apps) for another daemon whose process is alive or `ownerPid`. */
async function seedForeignMacClaim(
  root: string,
  options: { bundleId?: string; ownerPid?: number } = {},
): Promise<string> {
  const stateDir = path.join(root, `foreign-${options.bundleId ?? 'mac'}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const seeded = await acquireDeviceClaim({
    device: mac,
    session: 'foreign',
    workspace: '/foreign',
    stateDir,
    ...(options.bundleId ? { app: { bundleId: options.bundleId } } : {}),
  });
  assert.equal(seeded.status, 'acquired');
  if (seeded.status !== 'acquired') throw new Error('seed failed');
  const file = resolveDeviceClaimPath(seeded.ownership.deviceKey, process.env);
  const stored = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...stored,
      ownerPid: options.ownerPid ?? process.ppid,
      ownerStartTime: options.ownerPid ? 'long-gone' : null,
    }),
  );
  return file;
}

test('app claims of different apps coexist and the same app stays exclusive', async () => {
  const root = useClaimsRoot();
  await seedForeignMacClaim(root, { bundleId: 'com.example.one' });

  const other = await acquireDeviceClaim({
    device: mac,
    session: 'two',
    workspace: '/two',
    stateDir: root,
    app: { bundleId: 'com.example.two' },
  });
  assert.equal(other.status, 'acquired');
  if (other.status !== 'acquired') return;
  assert.equal(
    other.ownership.deviceKey,
    appScopedDeviceKey(canonicalLocalDeviceKey(mac), 'com.example.two'),
  );
  assert.deepEqual(
    inspectDeviceClaims({ udid: mac.id }, process.env)
      .map((entry) => entry.claim?.app?.bundleId)
      .sort(),
    ['com.example.one', 'com.example.two'],
  );

  const same = await acquireDeviceClaim({
    device: mac,
    session: 'three',
    workspace: '/three',
    stateDir: root,
    app: { bundleId: 'com.Example.One' },
  });
  assert.equal(same.status, 'conflict');
  if (same.status === 'conflict')
    assert.equal(same.conflict.claim?.app?.bundleId, 'com.example.one');
});

test('a whole-Mac claim and a foreign app claim exclude each other in both orders', async () => {
  const appFirst = useClaimsRoot();
  await seedForeignMacClaim(appFirst, { bundleId: 'com.example.one' });
  const whole = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: appFirst,
  });
  assert.equal(whole.status, 'conflict');
  if (whole.status !== 'conflict') return;
  assert.equal(whole.conflict.claim?.app?.bundleId, 'com.example.one');
  const transient = await acquireTransientDeviceClaim({
    device: mac,
    command: 'install',
    env: process.env,
    coveredBySession: 'whole',
    coveredClaimIsOwnedByRequest: () => false,
    workspace: '/whole',
    stateDir: appFirst,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'reconciled' }),
  });
  assert.equal(transient.status, 'conflict');

  const wholeFirst = useClaimsRoot();
  await seedForeignMacClaim(wholeFirst);
  const app = await acquireDeviceClaim({
    device: mac,
    session: 'app',
    workspace: '/app',
    stateDir: wholeFirst,
    app: { bundleId: 'com.example.one' },
  });
  assert.equal(app.status, 'conflict');
  if (app.status !== 'conflict') return;
  assert.equal(app.conflict.claim?.app, undefined);
});

test.each(['invalid-json', 'unknown'] as const)(
  'whole-Mac acquisition refuses an unverifiable claim scan: %s',
  async (failure) => {
    const root = useClaimsRoot();
    const file = await seedForeignMacClaim(root, { bundleId: 'com.example.one' });
    if (failure === 'invalid-json') fs.writeFileSync(file, '{');
    else
      vi.spyOn(claimInspection, 'inspectDeviceClaims').mockReturnValue([
        { fileName: path.basename(root), classification: 'unknown', error: 'EACCES' },
      ]);
    const before = fs.readFileSync(file, 'utf8');
    const whole = await acquireDeviceClaim({
      device: mac,
      session: 'whole',
      workspace: '/whole',
      stateDir: root,
    });
    assert.equal(whole.status, 'conflict');
    assert.equal(
      fs.existsSync(resolveDeviceClaimPath(canonicalLocalDeviceKey(mac), process.env)),
      false,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  },
);

test('whole-Mac acquisition ignores a readable claim for another device', async () => {
  const root = useClaimsRoot();
  const other = await acquireDeviceClaim({
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'ios-other',
      name: 'Other',
      kind: 'simulator',
      booted: true,
    },
    session: 'ios',
    workspace: '/ios',
    stateDir: root,
  });
  assert.equal(other.status, 'acquired');
  const whole = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: root,
  });
  assert.equal(whole.status, 'acquired');
});

test("a daemon's own app claims exclude whole-Mac session and transient claims", async () => {
  const root = useClaimsRoot();
  const app = await acquireDeviceClaim({
    device: mac,
    session: 'app',
    workspace: '/app',
    stateDir: root,
    app: { bundleId: 'com.example.one' },
  });
  assert.equal(app.status, 'acquired');
  const whole = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: root,
  });
  assert.equal(whole.status, 'conflict');
  const transient = await acquireTransientDeviceClaim({
    device: mac,
    command: 'install',
    coveredBySession: 'app',
    coveredClaimIsOwnedByRequest: () => true,
    workspace: '/app',
    stateDir: root,
    env: process.env,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'reconciled' }),
  });
  assert.equal(transient.status, 'conflict');
});

test('a whole-Mac claim settles a dead owner app claim and keeps one with unsettled resources', async () => {
  const root = useClaimsRoot();
  const retainedFile = await seedForeignMacClaim(root, {
    bundleId: 'com.example.one',
    ownerPid: 999_999_999,
  });
  const retained = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: root,
  });
  assert.equal(retained.status, 'conflict');
  assert.equal(fs.existsSync(retainedFile), true);

  const reconciled: string[] = [];
  const settled = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: root,
    reconcileOrphanedDeviceClaim: async (claim) => {
      reconciled.push(claim.deviceKey);
      return { status: 'reconciled' };
    },
  });
  assert.equal(settled.status, 'acquired');
  assert.deepEqual(reconciled, [
    appScopedDeviceKey(canonicalLocalDeviceKey(mac), 'com.example.one'),
  ]);
  assert.equal(fs.existsSync(retainedFile), false);
});

test('an app claim of a dead owner is released by release --stale like any claim', async () => {
  const root = useClaimsRoot();
  const file = await seedForeignMacClaim(root, {
    bundleId: 'com.example.one',
    ownerPid: 999_999_999,
  });
  const outcomes = await releaseProvenStaleDeviceClaims({
    selectors: {},
    env: process.env,
    reconcile: async () => ({ status: 'reconciled' }),
  });
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['released'],
  );
  assert.equal(fs.existsSync(file), false);
});

test("an app claim taken over this daemon's abandoned whole-Mac claim leaves other daemons' apps free", async () => {
  const root = useClaimsRoot();
  const whole = await acquireDeviceClaim({
    device: mac,
    session: 'desktop',
    workspace: '/desktop',
    stateDir: root,
  });
  assert.equal(whole.status, 'acquired');
  if (whole.status !== 'acquired') return;
  assert.equal(await abandonDeviceClaim(whole.ownership, process.env), 'abandoned');

  const app = await acquireDeviceClaim({
    device: mac,
    session: 'app',
    workspace: '/app',
    stateDir: root,
    app: { bundleId: 'com.example.one' },
  });
  assert.equal(app.status, 'acquired');
  if (app.status !== 'acquired') return;
  assert.deepEqual(app.ownership.app, { bundleId: 'com.example.one' });
  assert.equal(
    fs.existsSync(resolveDeviceClaimPath(canonicalLocalDeviceKey(mac), process.env)),
    false,
  );

  const foreignStateDir = path.join(root, 'foreign');
  fs.mkdirSync(foreignStateDir);
  const foreign = await acquireDeviceClaim({
    device: mac,
    session: 'foreign',
    workspace: '/foreign',
    stateDir: foreignStateDir,
    app: { bundleId: 'com.example.two' },
  });
  assert.equal(foreign.status, 'acquired');
});

test('whole-Mac acquisition supersedes only its own abandoned app claims', async () => {
  const root = useClaimsRoot();
  const app = await acquireDeviceClaim({
    device: mac,
    session: 'app',
    workspace: '/app',
    stateDir: root,
    app: { bundleId: 'com.example.one' },
  });
  assert.equal(app.status, 'acquired');
  if (app.status !== 'acquired') throw new Error('seed failed');
  assert.equal(await abandonDeviceClaim(app.ownership, process.env), 'abandoned');
  const whole = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: root,
  });
  assert.equal(whole.status, 'acquired');
  assert.equal(fs.existsSync(resolveDeviceClaimPath(app.ownership.deviceKey, process.env)), false);

  const foreignRoot = useClaimsRoot();
  const foreignFile = await seedForeignMacClaim(foreignRoot, { bundleId: 'com.example.two' });
  const foreign = JSON.parse(fs.readFileSync(foreignFile, 'utf8'));
  fs.writeFileSync(foreignFile, JSON.stringify({ ...foreign, abandonedAtMs: Date.now() }));
  const refused = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: foreignRoot,
  });
  assert.equal(refused.status, 'conflict');
  assert.equal(fs.existsSync(foreignFile), true);
});

test('failed whole-Mac acquisition leaves its abandoned app fenced against foreign acquisition', async () => {
  const root = useClaimsRoot();
  const app = await acquireDeviceClaim({
    device: mac,
    session: 'app',
    workspace: '/app',
    stateDir: root,
    app: { bundleId: 'com.example.one' },
  });
  if (app.status !== 'acquired') throw new Error('seed failed');
  await abandonDeviceClaim(app.ownership, process.env);
  await seedForeignMacClaim(root, { bundleId: 'com.example.two' });
  const entries = inspectDeviceClaims({}, process.env);
  const own = entries.find((entry) => entry.claim?.app?.bundleId === 'com.example.one')!;
  const foreign = entries.find((entry) => entry.claim?.app?.bundleId === 'com.example.two')!;
  const orderedScan = vi
    .spyOn(claimInspection, 'inspectDeviceClaims')
    .mockReturnValue([own, foreign]);
  const whole = await acquireDeviceClaim({
    device: mac,
    session: 'whole',
    workspace: '/whole',
    stateDir: root,
  });
  orderedScan.mockRestore();
  assert.equal(whole.status, 'conflict');
  assert.equal(fs.existsSync(resolveDeviceClaimPath(app.ownership.deviceKey, process.env)), true);
  const otherState = path.join(root, 'other-daemon');
  fs.mkdirSync(otherState);
  const otherApp = await acquireDeviceClaim({
    device: mac,
    session: 'foreign',
    workspace: '/foreign',
    stateDir: otherState,
    app: { bundleId: 'com.example.one' },
  });
  assert.equal(otherApp.status, 'conflict');
});
