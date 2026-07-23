import { resolveTargetDevice } from '../core/dispatch-resolve.ts';
import { hasExplicitDeviceSelector } from './device-selector-intent.ts';
import { applyRequestLockPolicy } from './request-lock-policy.ts';
import { buildOpenTargetDeviceResolutionOptions } from './open-device-selection.ts';
import type { SessionStore } from './session-store.ts';
import type { DaemonRequest, SessionState } from './types.ts';

export type RequestExecutionLockKey = `session:${string}` | `device:${string}`;

export type LockedRequestBinding = {
  req: DaemonRequest;
  existingSession: SessionState | undefined;
};

export async function resolveRequestExecutionLockKeys(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): Promise<RequestExecutionLockKey[]> {
  const { req, sessionName, sessionStore } = params;
  const existingSession = sessionStore.get(sessionName);
  if (existingSession) {
    return [deviceExecutionLockKey(existingSession.device.id)];
  }

  const keys = new Set<RequestExecutionLockKey>([sessionExecutionLockKey(sessionName)]);
  const bindingReq = resolveFreshSessionBindingRequest(req);
  if (shouldResolveFreshSessionDeviceLock(bindingReq)) {
    try {
      // This is advisory lock selection before the request enters the lock; the
      // locked request still resolves and binds the target device authoritatively.
      const device = await resolveTargetDevice(
        bindingReq.flags ?? {},
        buildOpenTargetDeviceResolutionOptions(bindingReq.positionals?.[0]),
      );
      keys.add(deviceExecutionLockKey(device.id));
    } catch {
      // Fall back to session scoping when device resolution is not yet available.
    }
  }
  return orderRequestExecutionLockKeys(keys);
}

export function prepareLockedRequestBinding(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
}): LockedRequestBinding {
  const existingSession = params.sessionStore.get(params.sessionName);
  return {
    req: applyRequestLockPolicy(params.req, existingSession),
    existingSession,
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

function shouldResolveFreshSessionDeviceLock(req: DaemonRequest): boolean {
  return req.command === 'open' || hasExplicitDeviceSelector(req.flags);
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
