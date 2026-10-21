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
import { canonicalLocalDeviceKey, resolveDeviceClaimPath } from './device-claim-paths.ts';
import { inspectDeviceClaims } from './device-claim-inspection.ts';
import { hostAppDevice, hostDeviceIdPrefix, type DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceClaim } from './device-claim-record.ts';
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

/** The app a claim holds as an app device of `mac`, or `undefined` for a whole-Mac claim. */
function claimedApp(claim: DeviceClaim | undefined): string | undefined {
  const prefix = hostDeviceIdPrefix(mac.id);
  return claim?.device.id.startsWith(prefix) ? claim.device.id.slice(prefix.length) : undefined;
}

for (const [failure, opener] of [
  ['listing', 'transient'],
  ['reading', 'session'],
  ['reading', 'transient'],
  ['decoding', 'transient'],
] as const) {
  test(`whole-Mac ${opener} acquisition refuses an uncertain app device claim after ${failure} fails`, async () => {
    const root = useClaimsRoot();
    const file = await seedForeignMacClaim(root, { bundleId: 'com.example.one' });
    const original = fs.readFileSync(file, 'utf8');
    const denied = Object.assign(new Error('test access denied'), { code: 'EACCES' });
    if (failure === 'listing') {
      vi.spyOn(fs, 'readdirSync').mockImplementationOnce(() => {
        throw denied;
      });
    } else if (failure === 'reading') {
      fs.chmodSync(file, 0o000);
    } else {
      fs.writeFileSync(file, '{');
    }

    const params = { device: mac, workspace: '/whole', stateDir: root };
    const result =
      opener === 'session'
        ? await acquireDeviceClaim({ ...params, session: 'whole' })
        : await acquireTransientDeviceClaim({
            ...params,
            env: process.env,
            command: 'prepare',
            coveredBySession: 'whole',
            coveredClaimIsOwnedByRequest: () => false,
            reconcileOrphanedDeviceClaim: async () => ({
              status: 'retained',
              reason: 'test-no-recovery',
            }),
          });

    vi.restoreAllMocks();
    fs.chmodSync(file, 0o600);
    assert.equal(result.status, 'conflict');
    if (result.status !== 'conflict') return;
    assert.equal(
      result.conflict.classification,
      failure === 'decoding' ? 'inconsistent' : 'unknown',
    );
    assert.equal(
      result.conflict.fileName,
      failure === 'listing' ? path.basename(root) : path.basename(file),
    );
    assert.equal(
      fs.existsSync(resolveDeviceClaimPath(canonicalLocalDeviceKey(mac), process.env)),
      false,
    );
    assert.equal(fs.readFileSync(file, 'utf8'), failure === 'decoding' ? '{' : original);
  });
}

/** Claims `mac` (or one of its apps) for another daemon whose process is alive or `ownerPid`. */
async function seedForeignMacClaim(
  root: string,
  options: { bundleId?: string; ownerPid?: number } = {},
): Promise<string> {
  const stateDir = path.join(root, `foreign-${options.bundleId ?? 'mac'}`);
  fs.mkdirSync(stateDir, { recursive: true });
  const seeded = await acquireDeviceClaim({
    device: options.bundleId ? hostAppDevice(mac, options.bundleId) : mac,
    session: 'foreign',
    workspace: '/foreign',
    stateDir,
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

test('app device claims of different apps coexist and the same app stays exclusive', async () => {
  const root = useClaimsRoot();
  await seedForeignMacClaim(root, { bundleId: 'com.example.one' });

  const other = await acquireDeviceClaim({
    device: hostAppDevice(mac, 'com.example.two'),
    session: 'two',
    workspace: '/two',
    stateDir: root,
  });
  assert.equal(other.status, 'acquired');
  if (other.status !== 'acquired') return;
  assert.equal(
    other.ownership.deviceKey,
    canonicalLocalDeviceKey(hostAppDevice(mac, 'com.example.two')),
  );
  assert.deepEqual(
    inspectDeviceClaims({}, process.env)
      .map((entry) => claimedApp(entry.claim))
      .sort(),
    ['com.example.one', 'com.example.two'],
  );

  const same = await acquireDeviceClaim({
    device: hostAppDevice(mac, 'com.Example.One'),
    session: 'three',
    workspace: '/three',
    stateDir: root,
  });
  assert.equal(same.status, 'conflict');
  if (same.status === 'conflict') assert.equal(claimedApp(same.conflict.claim), 'com.example.one');
});

test('a whole-Mac claim and a foreign app device claim exclude each other in both orders', async () => {
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
  assert.equal(claimedApp(whole.conflict.claim), 'com.example.one');
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
    device: hostAppDevice(mac, 'com.example.one'),
    session: 'app',
    workspace: '/app',
    stateDir: wholeFirst,
  });
  assert.equal(app.status, 'conflict');
  if (app.status !== 'conflict') return;
  assert.equal(claimedApp(app.conflict.claim), undefined);
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

test("a daemon's own app device claims exclude whole-Mac session and transient claims", async () => {
  const root = useClaimsRoot();
  const app = await acquireDeviceClaim({
    device: hostAppDevice(mac, 'com.example.one'),
    session: 'app',
    workspace: '/app',
    stateDir: root,
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

test('a whole-Mac claim settles the app device claim of a dead owner and keeps one with unsettled resources', async () => {
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
  assert.deepEqual(reconciled, [canonicalLocalDeviceKey(hostAppDevice(mac, 'com.example.one'))]);
  assert.equal(fs.existsSync(retainedFile), false);
});

test('an app device claim of a dead owner is released by release --stale like any claim', async () => {
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

test("an app device claim taken over this daemon's abandoned whole-Mac claim leaves other daemons' apps free", async () => {
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
    device: hostAppDevice(mac, 'com.example.one'),
    session: 'app',
    workspace: '/app',
    stateDir: root,
  });
  assert.equal(app.status, 'acquired');
  if (app.status !== 'acquired') return;
  assert.equal(
    app.ownership.deviceKey,
    canonicalLocalDeviceKey(hostAppDevice(mac, 'com.example.one')),
  );
  assert.equal(
    fs.existsSync(resolveDeviceClaimPath(canonicalLocalDeviceKey(mac), process.env)),
    false,
  );

  const foreignStateDir = path.join(root, 'foreign');
  fs.mkdirSync(foreignStateDir);
  const foreign = await acquireDeviceClaim({
    device: hostAppDevice(mac, 'com.example.two'),
    session: 'foreign',
    workspace: '/foreign',
    stateDir: foreignStateDir,
  });
  assert.equal(foreign.status, 'acquired');
});

test('whole-Mac acquisition supersedes only its own abandoned app claims', async () => {
  const root = useClaimsRoot();
  const app = await acquireDeviceClaim({
    device: hostAppDevice(mac, 'com.example.one'),
    session: 'app',
    workspace: '/app',
    stateDir: root,
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
    device: hostAppDevice(mac, 'com.example.one'),
    session: 'app',
    workspace: '/app',
    stateDir: root,
  });
  if (app.status !== 'acquired') throw new Error('seed failed');
  await abandonDeviceClaim(app.ownership, process.env);
  await seedForeignMacClaim(root, { bundleId: 'com.example.two' });
  const entries = inspectDeviceClaims({}, process.env);
  const own = entries.find((entry) => claimedApp(entry.claim) === 'com.example.one')!;
  const foreign = entries.find((entry) => claimedApp(entry.claim) === 'com.example.two')!;
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
    device: hostAppDevice(mac, 'com.example.one'),
    session: 'foreign',
    workspace: '/foreign',
    stateDir: otherState,
  });
  assert.equal(otherApp.status, 'conflict');
});
