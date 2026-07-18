import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  acquireAdvisoryDeviceClaim,
  canonicalLocalDeviceKey,
  clearAdvisoryDeviceClaim,
} from '../device-claims.ts';
import { inspectDeviceClaims } from '../device-claim-inspection.ts';
import type { DeviceInfo } from '../../kernel/device.ts';

const device: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel',
  kind: 'emulator',
  booted: true,
};

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function useClaimsRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-claims-'));
  roots.push(root);
  process.env.AGENT_DEVICE_CLAIMS_DIR = root;
  return root;
}

function claimPath(root: string): string {
  const key = canonicalLocalDeviceKey(device);
  const hash = crypto.createHash('sha256').update(key).digest('hex');
  return path.join(root, `${hash}.json`);
}

test('preserves a live foreign advisory claim without blocking or overwriting it', async () => {
  const root = useClaimsRoot();
  const first = await acquireAdvisoryDeviceClaim({
    device,
    session: 'first',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.ok(first.ownership);
  const second = await acquireAdvisoryDeviceClaim({
    device,
    session: 'second',
    workspace: '/worktrees/second',
    stateDir: root,
  });
  assert.equal(second.ownership, undefined);
  assert.equal(second.conflict?.classification, 'live');
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.session, 'first');
});

test('does not treat a same-named session in another worktree as its claim owner', async () => {
  const root = useClaimsRoot();
  const first = await acquireAdvisoryDeviceClaim({
    device,
    session: 'default',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.ok(first.ownership);
  const second = await acquireAdvisoryDeviceClaim({
    device,
    session: 'default',
    workspace: '/worktrees/second',
    stateDir: path.join(root, 'second-state'),
  });
  assert.equal(second.ownership, undefined);
  await clearAdvisoryDeviceClaim(second.ownership);
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.workspace, '/worktrees/first');
});

test('clears only the exact owner token and identity, never a successor claim', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireAdvisoryDeviceClaim({
    device,
    session: 'first',
    workspace: '/worktrees/first',
    stateDir: root,
  });
  assert.ok(acquired.ownership);
  const stored = JSON.parse(fs.readFileSync(claimPath(root), 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    claimPath(root),
    JSON.stringify({ ...stored, ownerToken: 'successor-token', session: 'second' }),
  );
  await clearAdvisoryDeviceClaim(acquired.ownership);
  assert.equal(inspectDeviceClaims({ serial: device.id })[0]?.claim?.session, 'second');
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
  await acquireAdvisoryDeviceClaim({
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
