import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  acquireDeviceClaim,
  acquireWrapperDeviceClaim,
  canonicalLocalDeviceKey,
  inspectDeviceClaims,
} from './device-claims.ts';
import { resolveDeviceClaimPath } from './device-claim-paths.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { mkdtempForTestSync, publishDaemonRegistration } from '@agent-device/test-kit';

// #3263: the `exec` claim wrapper records its claims with `claimOwnerKind:
// 'wrapper'` because a plain CLI process is never the daemon a state dir's
// registration can
// name. These tests pin that a live wrapper claim cannot be read as superseded
// (stealable) from a registration, and that the wrapper entry point records the
// kind and the command label.

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
  const root = mkdtempForTestSync('agent-device-wrapper-claims-');
  roots.push(root);
  process.env.AGENT_DEVICE_CLAIMS_DIR = root;
  return root;
}

function storedClaimFile(): string {
  return resolveDeviceClaimPath(canonicalLocalDeviceKey(device), process.env);
}

/**
 * Moves the stored claim to another live pid (the test host's parent): a foreign
 * caller then judges a live foreign owner, exactly as a second workspace's
 * `open` judges a wrapper it cannot reach.
 */
function handStoredClaimToAnotherLiveProcess(): void {
  const filePath = storedClaimFile();
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(
    filePath,
    JSON.stringify({ ...stored, ownerPid: process.ppid, ownerStartTime: null }),
  );
}

test('a wrapper claim records its owner kind and names the wrapped command', async () => {
  const root = useClaimsRoot();
  const acquired = await acquireWrapperDeviceClaim({
    device,
    env: process.env,
    command: 'expo',
    workspace: '/worktrees/wrapper',
    stateDir: root,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'reconciled' as const }),
  });
  assert.equal(acquired.status, 'acquired');
  const stored = JSON.parse(fs.readFileSync(storedClaimFile(), 'utf8')) as Record<string, unknown>;
  assert.equal(stored.claimOwnerKind, 'wrapper');
  const inspected = inspectDeviceClaims({ serial: device.id }, process.env)[0];
  assert.equal(inspected?.claim?.session, 'exec:expo');
  assert.equal(inspected?.claim?.ownerPid, process.pid);
  assert.equal(inspected?.classification, 'live');
});

test('a live wrapper claim survives a daemon registration published for its state dir', async () => {
  // #3263, the steal bug: the supersession proof reads the state dir's
  // `daemon.json`, which answers "which daemon serves this state dir" only. A
  // wrapper is never named there, so a registration must not make its live
  // claim reclaimable.
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'exec-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const wrapper = await acquireWrapperDeviceClaim({
    device,
    env: process.env,
    command: 'expo',
    workspace: '/worktrees/wrapper',
    stateDir,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'reconciled' as const }),
  });
  assert.equal(wrapper.status, 'acquired');
  handStoredClaimToAnotherLiveProcess();
  publishDaemonRegistration(stateDir, readCurrentOwnerIdentity());
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const second = await acquireDeviceClaim({
    device,
    env: process.env,
    session: 'foreign-session',
    workspace: '/worktrees/foreign',
    stateDir: path.join(root, 'foreign-state'),
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'conflict');
  if (second.status !== 'conflict') return;
  assert.equal(second.conflict.classification, 'live');
  assert.equal(reconcile.mock.calls.length, 0);
});

test('a daemon-served claim is still reclaimed from a superseded registration', async () => {
  // The closest negative: the proof stays live for the claims it was written
  // about. Same registration, same foreign live owner — only a daemon-served
  // claim (no owner kind) is answerable by the registration.
  const root = useClaimsRoot();
  const stateDir = path.join(root, 'daemon-state');
  fs.mkdirSync(stateDir, { recursive: true });
  const seeded = await acquireDeviceClaim({
    device,
    env: process.env,
    session: 'superseded-daemon-session',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test-no-recovery' }),
  });
  assert.equal(seeded.status, 'acquired');
  handStoredClaimToAnotherLiveProcess();
  publishDaemonRegistration(stateDir, readCurrentOwnerIdentity());
  const reconcile = vi.fn(async () => ({ status: 'reconciled' as const }));

  const second = await acquireDeviceClaim({
    device,
    env: process.env,
    session: 'successor-session',
    workspace: '/w',
    stateDir,
    reconcileOrphanedDeviceClaim: reconcile,
  });

  assert.equal(second.status, 'acquired');
  assert.equal(reconcile.mock.calls.length, 1);
});
