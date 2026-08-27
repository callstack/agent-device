import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.ts';
import type { DeviceClaimReconciler } from '../../daemon/device-claims.ts';
import { type OwnerIdentity } from '@agent-device/host-kit/process';

export type IsolatedDeviceClaimStore = {
  /** Temporary root holding both the claim store and the daemon state dir. */
  root: string;
  stateDir: string;
  claimsDir: string;
};

/**
 * Device claims are host-global by design, so a test that exercises them must
 * redirect the store. Registers cleanup once and returns a per-test factory.
 */
export function isolatedDeviceClaimStores(prefix: string): () => IsolatedDeviceClaimStore {
  const roots: string[] = [];
  afterEach(() => {
    delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  return () => {
    const root = mkdtempForTestSync(prefix);
    roots.push(root);
    const claimsDir = path.join(root, 'claims');
    process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    return { root, stateDir, claimsDir };
  };
}

/** Fail-closed reconciler: a test owner is never treated as recoverable. */
export const retainOrphanedDeviceClaims: DeviceClaimReconciler = async () => ({
  status: 'retained',
  reason: 'test-live-owner',
});

/**
 * Publishes the daemon registration a running daemon writes for its state dir.
 * Claim ownership is only reachable through the daemon named there, so tests
 * that exercise reachability have to stand one in.
 */
export function publishDaemonRegistration(stateDir: string, owner: OwnerIdentity): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'daemon.json'),
    JSON.stringify({
      port: 1,
      transport: 'socket',
      token: 'test-token',
      pid: owner.pid,
      ...(owner.startTime === null ? {} : { processStartTime: owner.startTime }),
      stateDir,
    }),
  );
}
