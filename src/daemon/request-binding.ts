import { resolveTargetDevice } from '@agent-device/device-selection/dispatch-resolve';
import { hasDeviceSelectionInput } from './device-selector-intent.ts';
import { applyRequestLockPolicy } from './request-lock-policy.ts';
import { buildOpenTargetDeviceResolutionOptions } from '@agent-device/device-selection/open-target';
import { buildReplayTargetDeviceResolution } from './replay-device-selection.ts';
import type { SessionStore } from './session-store.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionRef } from './session-state.ts';

export type RequestExecutionLockKey = `session:${string}` | `device:${string}`;

export type RequestExecutionLockPlan = {
  keys: RequestExecutionLockKey[];
  /**
   * The device {@link RequestExecutionLockPlan.keys} reserves, or `undefined` when the plan locks
   * only the session. A caller that must look at this device before it holds the lock reads it
   * here rather than resolving a target of its own, so one request has one answer to "which
   * device am I waiting for"; the locked request still resolves and binds its device alone.
   */
  deviceId: string | undefined;
};

export type LockedRequestBinding = {
  req: DaemonRequest;
  existingRef: SessionRef | undefined;
};

export async function resolveRequestExecutionLockPlan(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<RequestExecutionLockPlan> {
  const { req, sessionName, sessionStore } = params;
  const existingSession = sessionStore.get(sessionName);
  if (existingSession) {
    return {
      keys: orderRequestExecutionLockKeys([
        sessionExecutionLockKey(sessionName),
        deviceExecutionLockKey(existingSession.device.id),
      ]),
      deviceId: existingSession.device.id,
    };
  }

  const keys = new Set<RequestExecutionLockKey>([sessionExecutionLockKey(sessionName)]);
  const device = await resolveFreshSessionDevice(req);
  if (device) keys.add(deviceExecutionLockKey(device.id));
  return { keys: orderRequestExecutionLockKeys(keys), deviceId: device?.id };
}

export function prepareLockedRequestBinding(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): LockedRequestBinding {
  const existingRef = params.sessionStore.lookup(params.sessionName);
  return {
    req: applyRequestLockPolicy(params.req, existingRef),
    existingRef,
  };
}

function resolveFreshSessionBindingRequest(req: DaemonRequest): DaemonRequest {
  if (!req.meta?.lockPolicy) return req;
  try {
    return applyRequestLockPolicy(req);
  } catch {
    // The request will be rejected during locked binding preparation. Keep lock
    // selection best-effort so invalid selectors do not block unrelated work.
    return req;
  }
}

function resolveFreshSessionDeviceLock(req: DaemonRequest):
  | {
      flags: NonNullable<DaemonRequest['flags']>;
      options: ReturnType<typeof buildOpenTargetDeviceResolutionOptions> | undefined;
    }
  | undefined {
  if (req.command === 'open') return resolveOpenDeviceLock(req);
  if (req.command === 'replay') return resolveReplayDeviceLock(req);
  return resolveExplicitDeviceLock(req);
}

/**
 * The device a fresh session is expected to bind, resolved the advisory way its device execution
 * lock is chosen. This runs before the request holds that lock and is never an authority on what
 * happens after: the locked request resolves and binds its device on its own.
 */
async function resolveFreshSessionDevice(req: DaemonRequest): Promise<DeviceInfo | undefined> {
  const resolution = resolveFreshSessionDeviceLock(resolveFreshSessionBindingRequest(req));
  if (!resolution) return undefined;
  try {
    return await resolveTargetDevice(resolution.flags, resolution.options);
  } catch {
    // Unresolvable here means unresolvable for lock selection too, which is already tolerated.
    return undefined;
  }
}

function resolveOpenDeviceLock(req: DaemonRequest) {
  const options = buildOpenTargetDeviceResolutionOptions(req.positionals?.[0]);
  return options ? { flags: req.flags ?? {}, options } : undefined;
}

function resolveReplayDeviceLock(req: DaemonRequest) {
  return buildReplayTargetDeviceResolution(req) ?? resolveExplicitDeviceLock(req);
}

function resolveExplicitDeviceLock(req: DaemonRequest) {
  return hasDeviceSelectionInput(req.flags) ? { flags: req.flags ?? {}, options: {} } : undefined;
}

function sessionExecutionLockKey(sessionName: string): RequestExecutionLockKey {
  return `session:${sessionName}`;
}

function deviceExecutionLockKey(deviceId: string): RequestExecutionLockKey {
  return `device:${deviceId}`;
}

function orderRequestExecutionLockKeys(
  keys: Iterable<RequestExecutionLockKey>,
): RequestExecutionLockKey[] {
  return Array.from(keys).sort((left, right) => {
    const categoryOrder = lockKeyCategoryOrder(left) - lockKeyCategoryOrder(right);
    if (categoryOrder !== 0) return categoryOrder;
    return left.localeCompare(right);
  });
}

function lockKeyCategoryOrder(key: RequestExecutionLockKey): number {
  return key.startsWith('session:') ? 0 : 1;
}
