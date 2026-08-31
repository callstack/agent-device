import type { DeviceInfo } from '@agent-device/kernel/device';

/**
 * Daemon-owned lease-owner state directory for the Apple runner. Kept in a
 * dedicated tiny module so daemon startup can set it without loading the
 * runner client's implementation closure; the runner package reads it through
 * its host port at lease time.
 */
let runnerLeaseOwnerStateDir: string | undefined;

export function setRunnerLeaseOwnerStateDir(stateDir: string | undefined): void {
  runnerLeaseOwnerStateDir = stateDir?.trim() || undefined;
}

export function getRunnerLeaseOwnerStateDir(): string | undefined {
  return runnerLeaseOwnerStateDir;
}

/**
 * Daemon-owned device-claim arbitration probe: does the embedding process hold
 * the host-global local device claim for exactly this device right now? The
 * probe receives the full device so the claim owner can match its canonical
 * platform-family/OS/id key — a bare id is ambiguous across families. Unbound
 * (in embedders that run no claim store, such as package tests) it answers
 * false, which keeps runner-lease takeover disabled there.
 */
export type RunnerDeviceClaimAuthorityProbe = (device: DeviceInfo) => boolean;

let runnerDeviceClaimAuthorityProbe: RunnerDeviceClaimAuthorityProbe | undefined;

export function setRunnerDeviceClaimAuthorityProbe(
  probe: RunnerDeviceClaimAuthorityProbe | undefined,
): void {
  runnerDeviceClaimAuthorityProbe = probe;
}

export function getRunnerDeviceClaimAuthorityProbe(): RunnerDeviceClaimAuthorityProbe | undefined {
  return runnerDeviceClaimAuthorityProbe;
}
