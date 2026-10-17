import { AsyncLocalStorage } from 'node:async_hooks';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { RuntimeStateHandle } from '@agent-device/host-kit/runtime-slots';

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
type RunnerRuntimeState = {
  leaseOwnerStateDir: string | undefined;
  deviceClaimAuthorityProbe: RunnerDeviceClaimAuthorityProbe | undefined;
  slots: Map<symbol, unknown>;
};

const createRunnerRuntimeState = (): RunnerRuntimeState => ({
  leaseOwnerStateDir: undefined,
  deviceClaimAuthorityProbe: undefined,
  slots: new Map(),
});

const runnerRuntimeStorage = new AsyncLocalStorage<RunnerRuntimeState>();
// Outside a daemon runtime (a package test, a tool that drives the runner directly) this answers.
const standaloneRunnerRuntime = createRunnerRuntimeState();
const runnerRuntimeState = (): RunnerRuntimeState =>
  runnerRuntimeStorage.getStore() ?? standaloneRunnerRuntime;

export function createAppleRunnerRuntimeState(): RuntimeStateHandle {
  const owned = createRunnerRuntimeState();
  return {
    run: (fn) => runnerRuntimeStorage.run(owned, fn),
    enter: () => runnerRuntimeStorage.enterWith(owned),
    dispose: () => owned.slots.clear(),
  };
}

/** One piece of runner state this daemon runtime owns, created on first use. */
export function runnerRuntimeSlot<T>(key: symbol, create: () => T): T {
  const { slots } = runnerRuntimeState();
  if (!slots.has(key)) slots.set(key, create());
  return slots.get(key) as T;
}

export function setRunnerLeaseOwnerStateDir(stateDir: string | undefined): void {
  runnerRuntimeState().leaseOwnerStateDir = stateDir?.trim() || undefined;
}

export function getRunnerLeaseOwnerStateDir(): string | undefined {
  return runnerRuntimeState().leaseOwnerStateDir;
}

export function setRunnerDeviceClaimAuthorityProbe(
  probe: RunnerDeviceClaimAuthorityProbe | undefined,
): void {
  runnerRuntimeState().deviceClaimAuthorityProbe = probe;
}

export function getRunnerDeviceClaimAuthorityProbe(): RunnerDeviceClaimAuthorityProbe | undefined {
  return runnerRuntimeState().deviceClaimAuthorityProbe;
}
