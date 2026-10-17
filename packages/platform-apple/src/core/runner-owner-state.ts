import type { DeviceInfo } from '@agent-device/kernel/device';
import { defineRuntimeSlots, type RuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';

/**
 * Daemon-owned device-claim arbitration probe: does the embedding process hold
 * the host-global local device claim for exactly this device right now? The
 * probe receives the full device so the claim owner can match its canonical
 * platform-family/OS/id key — a bare id is ambiguous across families. Unbound
 * (in embedders that run no claim store, such as package tests) it answers
 * false, which keeps runner-lease takeover disabled there.
 */
export type RunnerDeviceClaimAuthorityProbe = (device: DeviceInfo) => boolean;

/**
 * What one daemon runtime owns of the Apple runner: the lease-owner state directory and claim probe
 * its daemon set, and the registries (sessions, locks, recycle ledger) the runner modules keep in
 * {@link runnerRuntimeSlot}s. Kept in a dedicated tiny module so daemon startup can reach it
 * without loading the runner client's implementation closure; the runner package reads it through
 * its host port.
 */
const runnerRuntime = defineRuntimeSlots();

export const createAppleRunnerRuntimeState = (): RuntimeStateHandle => runnerRuntime.createHandle();

/** One piece of runner state this daemon runtime owns, created on first use. */
export const runnerRuntimeSlot = runnerRuntime.slot;

type RunnerOwner = {
  leaseOwnerStateDir: string | undefined;
  deviceClaimAuthorityProbe: RunnerDeviceClaimAuthorityProbe | undefined;
};
const RUNNER_OWNER_SLOT = Symbol('appleRunnerOwner');
const runnerOwner = (): RunnerOwner =>
  runnerRuntimeSlot(RUNNER_OWNER_SLOT, (): RunnerOwner => ({
    leaseOwnerStateDir: undefined,
    deviceClaimAuthorityProbe: undefined,
  }));

export function setRunnerLeaseOwnerStateDir(stateDir: string | undefined): void {
  runnerOwner().leaseOwnerStateDir = stateDir?.trim() || undefined;
}

export function getRunnerLeaseOwnerStateDir(): string | undefined {
  return runnerOwner().leaseOwnerStateDir;
}

export function setRunnerDeviceClaimAuthorityProbe(
  probe: RunnerDeviceClaimAuthorityProbe | undefined,
): void {
  runnerOwner().deviceClaimAuthorityProbe = probe;
}

export function getRunnerDeviceClaimAuthorityProbe(): RunnerDeviceClaimAuthorityProbe | undefined {
  return runnerOwner().deviceClaimAuthorityProbe;
}
