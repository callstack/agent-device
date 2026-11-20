import fs from 'node:fs';
import path from 'node:path';
import { afterEach } from 'vitest';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import type { DeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claims';

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
    // The runtime admits its state root before it locks or recovers, so a fixture's root must be one that
    // passes the rule the runtime enforces: private, like every real state directory has to be.
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(stateDir, 0o700);
    return { root, stateDir, claimsDir };
  };
}

/** Fail-closed reconciler: a test owner is never treated as recoverable. */
export const retainOrphanedDeviceClaims: DeviceClaimReconciler = async () => ({
  status: 'retained',
  reason: 'test-live-owner',
});
