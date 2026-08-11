// Production lock-plan + device bindings for the concurrency torture lane (#1416).
//
// The lane does NOT hand-write which locks an operation takes. It derives the
// plan from the REAL router primitive `resolveRequestExecutionLockKeys`
// (src/daemon/request-binding.ts), driven with a fake in-memory device
// inventory via the production `withDeviceInventoryProvider` seam. This is what
// makes the same-device serialization invariant revert-sensitive: if production
// stops returning a `device:` key (e.g. the router's same-device open
// serialization is reverted), the derived plan changes and the lane's overlap
// invariant fires.
//
// The plan is built the SAME way the daemon builds it in
// `createRequestExecutionScope`: gate on the production decision
// `shouldLockSessionExecution(command)`, and only then resolve keys via
// `resolveRequestExecutionLockKeys`. So the lane is revert-sensitive to BOTH
// production decision points — exempting a command from execution locking, or
// dropping the device key — even though the mutex GRANT itself stays modeled
// (by the deterministic scheduler) because `withKeyedLock`'s native microtask
// hand-off cannot be reproduced from a seed.

import type { DeviceInfo } from '@agent-device/kernel/device';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonRequest } from '../../../../src/daemon/types.ts';
import type { SessionStore } from '../../../../src/daemon/session-store.ts';
import { resolveRequestExecutionLockKeys } from '../../../../src/daemon/request-binding.ts';
import { shouldLockSessionExecution } from '../../../../src/daemon/daemon-command-registry.ts';
import { PUBLIC_COMMANDS } from '../../../../src/command-catalog.ts';
import { withTestDeviceInventoryProvider as withDeviceInventoryProvider } from '../../../../src/__tests__/test-utils/device-inventory-gateways.ts';

import type { LockKey } from './deterministic-scheduler.ts';

// Production command each modeled op routes as, so the lane consumes the real
// `shouldLockSessionExecution` gate rather than assuming every op locks.
const OPEN_COMMAND = PUBLIC_COMMANDS.open;
export const MUTATE_COMMAND = PUBLIC_COMMANDS.click;
export const CLOSE_COMMAND = PUBLIC_COMMANDS.close;

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

/** The enforced-claim device key the daemon derives for a resolved device. */
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
    command: OPEN_COMMAND,
    positionals: [],
    token: 'torture',
    session: sessionName,
    flags: selectorFlagsForDevice(device),
  } as DaemonRequest;
}

function existingSessionRequest(command: string, sessionName: string): DaemonRequest {
  return {
    command,
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
 * Resolve a request's execution lock plan EXACTLY as `createRequestExecutionScope`
 * does: skip locking entirely when the command is execution-lock-exempt, else
 * resolve the keys through the production router. Reverting either production
 * decision changes what this returns.
 */
async function resolveExecutionLockPlan(
  req: DaemonRequest,
  sessionName: string,
  sessionStore: SessionStore,
): Promise<LockKey[]> {
  if (!shouldLockSessionExecution(req.command)) return [];
  return (await withPool(() =>
    resolveRequestExecutionLockKeys({ req, sessionName, sessionStore }),
  )) as LockKey[];
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
  return await resolveExecutionLockPlan(
    openRequest(device, sessionName),
    sessionName,
    sessionStore,
  );
}

/**
 * Lock plan for `command` on an already-open session, computed by the production
 * router (`[device:<id>]`, read from the stored session's device).
 */
export async function resolveExistingLockPlan(
  sessionStore: SessionStore,
  sessionName: string,
  command: string,
): Promise<LockKey[]> {
  return await resolveExecutionLockPlan(
    existingSessionRequest(command, sessionName),
    sessionName,
    sessionStore,
  );
}
