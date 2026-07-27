// Production lock-plan + device bindings for the concurrency torture lane (#1416).
//
// The lane does NOT hand-write which locks an operation takes. It derives the
// plan from the REAL router primitive `resolveRequestExecutionLockKeys`
// (src/daemon/request-binding.ts), driven with a fake in-memory device
// inventory via the production `withDeviceInventoryProvider` seam. This is what
// makes the same-device serialization invariant revert-sensitive: if production
// stops returning a `device:` key (e.g. the router's same-device open
// serialization is reverted), the derived plan changes and the lane's overlap
// invariant fires. Only the mutex GRANT is modeled (by the deterministic
// scheduler) because `withKeyedLock`'s native microtask hand-off cannot be
// reproduced from a seed.

import type { DeviceInfo } from '../../../src/kernel/device.ts';
import type { CommandFlags } from '../../../src/core/dispatch-context.ts';
import type { DaemonRequest } from '../../../src/daemon/types.ts';
import type { SessionStore } from '../../../src/daemon/session-store.ts';
import { resolveRequestExecutionLockKeys } from '../../../src/daemon/request-binding.ts';
import { withDeviceInventoryProvider } from '../../../src/core/dispatch-resolve.ts';

import type { LockKey } from './deterministic-scheduler.ts';

export const DEVICE_POOL: readonly DeviceInfo[] = [
  {
    platform: 'apple',
    id: 'sim-a',
    name: 'iPhone A',
    kind: 'simulator',
    appleOs: 'ios',
    booted: true,
  },
  {
    platform: 'apple',
    id: 'sim-b',
    name: 'iPhone B',
    kind: 'simulator',
    appleOs: 'ios',
    booted: true,
  },
  { platform: 'android', id: 'emu-c', name: 'Pixel C', kind: 'emulator', booted: true },
];

/** The lease scope for one opened session, kept so the harness can release it. */
export type LeaseScope = {
  leaseId: string;
  tenantId: string;
  runId: string;
  leaseBackend: 'ios-simulator';
  deviceKey: string;
  clientId: string;
};

/**
 * Shadow record of one session instance the harness opened. `instanceId` is
 * unique across the whole run even when a session NAME is reused, so a stale
 * reference can never be mistaken for a live one.
 */
export type SessionInstance = {
  instanceId: number;
  name: string;
  deviceId: string;
  deviceKey: string;
  lease: LeaseScope;
  claim: { deviceKey: string; ownerToken: string; session: string };
  ownerClient: number;
  dead: boolean;
  reaped: boolean;
  mutations: number;
};

/** The advisory-claim device key the daemon derives for a resolved device. */
export function deviceClaimKey(device: DeviceInfo): string {
  return `local:${device.platform}:${device.appleOs ?? 'none'}:${device.id}`;
}

/** An explicit device selector that resolves to exactly `device` in the pool. */
function selectorFlagsForDevice(device: DeviceInfo): CommandFlags {
  return device.platform === 'android'
    ? ({ platform: 'android', serial: device.id } as CommandFlags)
    : ({ platform: 'ios', udid: device.id } as CommandFlags);
}

function openRequest(device: DeviceInfo, sessionName: string): DaemonRequest {
  return {
    command: 'open',
    positionals: [],
    token: 'torture',
    session: sessionName,
    flags: selectorFlagsForDevice(device),
  } as DaemonRequest;
}

function existingSessionRequest(sessionName: string): DaemonRequest {
  return {
    command: 'is',
    positionals: [],
    token: 'torture',
    session: sessionName,
    flags: {} as CommandFlags,
  } as DaemonRequest;
}

async function withPool<T>(task: () => Promise<T>): Promise<T> {
  return await withDeviceInventoryProvider(async () => [...DEVICE_POOL], task);
}

/**
 * Lock plan for a fresh open of `device` under `sessionName`, computed by the
 * production router (`[session:<name>, device:<id>]` when the device resolves).
 */
export async function resolveOpenLockPlan(
  sessionStore: SessionStore,
  sessionName: string,
  device: DeviceInfo,
): Promise<LockKey[]> {
  return (await withPool(() =>
    resolveRequestExecutionLockKeys({
      req: openRequest(device, sessionName),
      sessionName,
      sessionStore,
    }),
  )) as LockKey[];
}

/**
 * Lock plan for an operation on an already-open session, computed by the
 * production router (`[device:<id>]`, read from the stored session's device).
 */
export async function resolveExistingLockPlan(
  sessionStore: SessionStore,
  sessionName: string,
): Promise<LockKey[]> {
  return (await withPool(() =>
    resolveRequestExecutionLockKeys({
      req: existingSessionRequest(sessionName),
      sessionName,
      sessionStore,
    }),
  )) as LockKey[];
}
