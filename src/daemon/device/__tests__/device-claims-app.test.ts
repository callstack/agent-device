import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  abandonDeviceClaim,
  acquireDeviceClaim as acquireProductionDeviceClaim,
  acquireTransientDeviceClaim,
  releaseProvenStaleDeviceClaims,
} from '../device-claims.ts';
import {
  appScopedDeviceKey,
  canonicalLocalDeviceKey,
  resolveDeviceClaimPath,
} from '../device-claim-paths.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/process', async (importOriginal) =>
  (await import('../../../__tests__/test-utils/host-process-mock.ts')).pinOwnProcessStartTime(
    importOriginal,
  ),
);

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
  const file = resolveDeviceClaimPath(seeded.ownership.deviceKey);
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
    inspectDeviceClaims({ udid: mac.id })
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

test("a daemon's own app claims do not fence its own whole-Mac claim", async () => {
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
  assert.equal(whole.status, 'acquired');
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
  assert.equal(await abandonDeviceClaim(whole.ownership), 'abandoned');

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
  assert.equal(fs.existsSync(resolveDeviceClaimPath(canonicalLocalDeviceKey(mac))), false);

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
