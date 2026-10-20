import type { DeviceInfo } from '@agent-device/kernel/device';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { runtimeSlot } from '@agent-device/host-kit/runtime-slots';

/**
 * Daemon-owned device-claim arbitration probe: does the embedding process hold
 * the host-global local device claim for exactly this device right now? The
 * probe receives the full device so the claim owner can match its canonical
 * platform-family/OS/id key — a bare id is ambiguous across families. Unbound
 * (in embedders that run no claim store, such as package tests) it answers
 * false, which keeps runner-lease takeover disabled there.
 */
export type RunnerDeviceClaimAuthorityProbe = (device: DeviceInfo) => boolean;

type RunnerOwner = {
  leaseOwnerStateDir: string | undefined;
  deviceClaimAuthorityProbe: RunnerDeviceClaimAuthorityProbe | undefined;
  hostEnvironment: HostEnvironment | undefined;
};

/**
 * The Apple runner's per-runtime owner state: the lease-owner state directory and claim probe
 * its daemon set, and the host that daemon's composition bound (#3794). The runner's registries
 * (sessions, locks, recycle ledger) are separate slots the runner modules declare on the same
 * store through the runner host port. Kept in a dedicated tiny module so daemon startup can
 * reach it without loading the runner client's implementation closure.
 */
const RUNNER_OWNER_SLOT = Symbol('appleRunnerOwner');
const runnerOwner = (): RunnerOwner =>
  runtimeSlot(RUNNER_OWNER_SLOT, (): RunnerOwner => ({
    leaseOwnerStateDir: undefined,
    deviceClaimAuthorityProbe: undefined,
    hostEnvironment: undefined,
  }));

/**
 * Binds the host this runtime captured for the Apple runner. Root composition calls it once per
 * runtime, inside the runtime's entered state, alongside the lease owner state; the runner host
 * port's `hostEnvironment` member answers from it (#3794).
 */
export function setAppleRunnerHostEnvironment(host: HostEnvironment): void {
  runnerOwner().hostEnvironment = host;
}

/** The host this runtime bound, or undefined when composition never entered one. */
export function getAppleRunnerHostEnvironment(): HostEnvironment | undefined {
  return runnerOwner().hostEnvironment;
}

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
