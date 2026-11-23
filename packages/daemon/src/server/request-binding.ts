import {
  ignoresSessionLease,
  shouldLockSessionExecution,
  resolveCommandAndroidAvdSelection,
  isSessionObservationRequest,
} from '../core/daemon-command-registry.ts';
import type { EnvMap } from '@agent-device/kernel/source-value';
import {
  hasDeviceSelectionInput,
  normalizeFreshForegroundOpenSelection,
} from '../core/device/device-selector-intent.ts';
import { applyRequestLockPolicy } from './request-lock-policy.ts';
import type { ResolveTargetDeviceOptions } from '@agent-device/device-selection/dispatch-resolve';
import { buildReplayTargetDeviceResolution } from './replay-device-selection.ts';
import { type SessionStore, SessionCoordinator } from '../core/session-store.ts';
import { hostAndDeviceIds, type DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError, type ReasonTable } from '@agent-device/kernel/errors';
import type { DaemonPlatformServices } from '../core/platform-services.ts';
import { remoteScriptVersionDelivery } from '../core/session-script-publication-capability.ts';
import {
  assertRequestLeaseAdmission,
  assertRequestTenantAdmission,
  assertProviderLeaseRequestNamesSession,
} from '../sessions/request-admission.ts';
import { createSessionVisibilityPredicate } from '../sessions/session-routing.ts';
import type { LeaseRegistry } from '../resources/lease-registry.ts';

const SNAPSHOT_OBSERVATION_REASONS = {
  // Android observe-only snapshots cannot read or update a stored diff baseline.
  options: { reason: 'android_observe_only_snapshot_options' },
  // The request cannot observe the session scope that owns the Android helper.
  ownerMismatch: { reason: 'snapshot_observation_owner_mismatch' },
} as const satisfies ReasonTable<'snapshot observation'>;

export function admitSnapshotObservation(params: {
  req: DaemonRequest;
  originalReq: DaemonRequest;
  device: DeviceInfo;
  sessionStore: SessionStore;
  leaseRegistry: LeaseRegistry;
  admission: Parameters<typeof assertRequestLeaseAdmission>[3];
  active: () => boolean;
}): DaemonRequest {
  const { req, device } = params;
  if (req.flags?.snapshotDiff) {
    throw new AppError('INVALID_ARGS', 'Android observe-only snapshots cannot use --diff.', {
      reason: SNAPSHOT_OBSERVATION_REASONS.options.reason,
    });
  }
  let admittedLease: ReturnType<typeof assertRequestLeaseAdmission>;
  const visible = createSessionVisibilityPredicate(req);
  const coordinator = new SessionCoordinator(params.sessionStore);
  const observation = coordinator.observeDevice(req, device, params.active, (session) => {
    assertRequestTenantAdmission(params.originalReq, session);
    assertProviderLeaseRequestNamesSession(req, session);
    if (session && !visible(session)) {
      throw new AppError(
        'UNAUTHORIZED',
        'The Android snapshot helper belongs to another session scope.',
        {
          reason: SNAPSHOT_OBSERVATION_REASONS.ownerMismatch.reason,
        },
      );
    }
    admittedLease = assertRequestLeaseAdmission(
      req,
      params.leaseRegistry,
      session,
      params.admission,
    );
  });
  return { ...req, internal: { ...req.internal, admittedLease, snapshotObservation: observation } };
}

export async function resolveDetachedObservationDevice(
  req: DaemonRequest,
  env: EnvMap,
): Promise<DeviceInfo | undefined> {
  if (isSessionObservationRequest(req) && req.flags?.serial) {
    const { resolveRequestTargetDevice } = await import('../core/request-device-resolution.ts');
    const device = await resolveRequestTargetDevice(req, { env });
    if (device.platform === 'android') return device;
  }
  return undefined;
}

export type RequestExecutionLockKey = `session:${string}` | `device:${string}`;

/**
 * The lock pair an already-bound session's commands take, in acquisition order. The #2833
 * session-idle expiry settles a session through these same keys in this same order: settling a
 * session while a device-lock-holding command still runs on its device would release a device
 * under work, and any other order would deadlock against a request's pair.
 */
export function existingSessionExecutionLockKeys(
  sessionName: string,
  deviceId: string,
): RequestExecutionLockKey[] {
  return orderRequestExecutionLockKeys([
    sessionExecutionLockKey(sessionName),
    deviceExecutionLockKey(deviceId),
  ]);
}

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

export function resolveRequestExecutionLockPlan(params: {
  req: DaemonRequest;
  sessionName: string;
  existingDeviceId?: string;
  env: EnvMap;
}): RequestExecutionLockPlan | Promise<RequestExecutionLockPlan> {
  const { req, sessionName, existingDeviceId, env } = params;
  if (existingDeviceId !== undefined) {
    return {
      keys: existingSessionExecutionLockKeys(sessionName, existingDeviceId),
      deviceId: existingDeviceId,
    };
  }

  return resolveFreshSessionDevice(req, env).then((device) => {
    const keys = new Set<RequestExecutionLockKey>([sessionExecutionLockKey(sessionName)]);
    // A fresh app open also locks its host (ADR 0035). A composite locks only its device.
    const ids = !device ? [] : req.command === 'open' ? hostAndDeviceIds(device) : [device.id];
    for (const id of ids) keys.add(deviceExecutionLockKey(id));
    return { keys: orderRequestExecutionLockKeys(keys), deviceId: device?.id };
  });
}

async function resolveFreshBoundedOpenDevice(req: DaemonRequest, env: EnvMap): Promise<DeviceInfo> {
  const { resolveForegroundOpenRequest } =
    await import('../sessions/session-lifecycle/internal/session-open.ts');
  const foreground = await resolveForegroundOpenRequest({ req, hasExistingSession: false });
  if (foreground.type === 'response') {
    if (!foreground.response.ok) {
      const { code, message, details } = foreground.response.error;
      throw new AppError(code, message, details);
    }
    throw new AppError('INVALID_ARGS', 'Invalid open target');
  }
  const openReq = foreground.type === 'resolved' ? foreground.req : req;
  const { resolveRequestTargetDeviceSelection } =
    await import('../core/request-device-resolution.ts');
  const { resolveOpenTargetDeviceOptions } =
    await import('../core/open-target-device-resolution.ts');
  return (
    await resolveRequestTargetDeviceSelection(openReq, resolveOpenTargetDeviceOptions(openReq, env))
  ).device;
}

export async function resolveBoundedClaimDevice(
  req: DaemonRequest,
  session: SessionState | undefined,
  env: EnvMap,
  platformServices: DaemonPlatformServices,
): Promise<DeviceInfo> {
  const { resolveBootCommandSelection, resolveCommandDevice, requireSessionOrExplicitSelector } =
    await import('../resources/session-device-resolution.ts');
  if (req.command !== 'open') {
    const guard = requireSessionOrExplicitSelector(req.command, session, req.flags);
    if (guard && !guard.ok) {
      const { code, message, details } = guard.error;
      throw new AppError(code, message, details);
    }
  }
  if (req.command === 'open') return await resolveFreshBoundedOpenDevice(req, env);
  if (req.command === 'install_source' && session) return session.device;
  const params = {
    session,
    req,
    env,
    platformServices,
    androidAvdSelection: resolveCommandAndroidAvdSelection(req.command),
  };
  if (req.command === 'boot') return (await resolveBootCommandSelection(params)).device;
  return await resolveCommandDevice(params);
}

export function prepareLockedRequestBinding(params: {
  req: DaemonRequest;
  existingRef: SessionRef | undefined;
}): LockedRequestBinding {
  const { existingRef } = params;
  return {
    req: applyRequestLockPolicy(params.req, existingRef),
    existingRef,
  };
}

function resolveFreshSessionBindingRequest(req: DaemonRequest): DaemonRequest {
  if (!req.meta?.lockPolicy) return normalizeFreshForegroundOpenSelection(req);
  try {
    return normalizeFreshForegroundOpenSelection(applyRequestLockPolicy(req));
  } catch {
    // The request will be rejected during locked binding preparation. Keep lock
    // selection best-effort so invalid selectors do not block unrelated work.
    return req;
  }
}

type FreshSessionDeviceLock = {
  flags: NonNullable<DaemonRequest['flags']>;
  options: ResolveTargetDeviceOptions | undefined;
};

/** An `open` always resolves its lock device with the open-target options. */
type OpenDeviceLock = FreshSessionDeviceLock & { options: ResolveTargetDeviceOptions };

async function resolveFreshSessionDeviceLock(
  req: DaemonRequest,
  env: EnvMap,
): Promise<FreshSessionDeviceLock | undefined> {
  if (req.command === 'open') return await resolveOpenDeviceLock(req, env);
  if (req.command === 'replay') return await resolveReplayDeviceLock(req, env);
  return resolveExplicitDeviceLock(req, env);
}

/**
 * The device a fresh session is expected to bind, resolved the advisory way its device execution
 * lock is chosen. This runs before the request holds that lock and is never an authority on what
 * happens after: the locked request resolves and binds its device on its own.
 */
async function resolveFreshSessionDevice(
  req: DaemonRequest,
  env: EnvMap,
): Promise<DeviceInfo | undefined> {
  const resolution = await resolveFreshSessionDeviceLock(
    resolveFreshSessionBindingRequest(req),
    env,
  );
  if (!resolution) return undefined;
  try {
    // Deferred to keep the daemon's eager closure within scripts/__tests__/eager-closure-budgets.ts.
    const { resolveRequestTargetDevice } = await import('../core/request-device-resolution.ts');
    // A fresh web session locks its own device whichever command starts it, never the shared host
    // device: a replay or batch locks only the device it starts on, as for an app device (ADR 0035).
    return await resolveRequestTargetDevice(req, { ...resolution.options, env }, resolution.flags);
  } catch {
    // Unresolvable here means unresolvable for lock selection too, which is already tolerated.
    return undefined;
  }
}

async function resolveOpenDeviceLock(req: DaemonRequest, env: EnvMap): Promise<OpenDeviceLock> {
  // Deferred to keep the daemon's eager closure within scripts/__tests__/eager-closure-budgets.ts.
  const { resolveOpenTargetDeviceOptions } =
    await import('../core/open-target-device-resolution.ts');
  return { flags: req.flags ?? {}, options: resolveOpenTargetDeviceOptions(req, env) };
}

async function resolveReplayDeviceLock(req: DaemonRequest, env: EnvMap) {
  return (await buildReplayTargetDeviceResolution(req, env)) ?? resolveExplicitDeviceLock(req, env);
}

function resolveExplicitDeviceLock(req: DaemonRequest, env: EnvMap) {
  return hasDeviceSelectionInput(req.flags)
    ? {
        flags: req.flags ?? {},
        options: { env, androidAvdSelection: resolveCommandAndroidAvdSelection(req.command) },
      }
    : undefined;
}

export function sessionExecutionLockKey(sessionName: string): RequestExecutionLockKey {
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

export async function withSessionScriptPublication(
  store: SessionStore,
  { req, existingRef }: LockedRequestBinding,
  dispatch: (req: DaemonRequest) => Promise<DaemonResponse>,
): Promise<DaemonResponse> {
  if (req.internal?.snapshotObservation) return await dispatch(req);
  if (!shouldLockSessionExecution(req.command) || ignoresSessionLease(req.command))
    return await dispatch(req);

  let active = true;
  const authorized =
    existingRef && new SessionCoordinator(store).authorize(req, existingRef, () => active);
  let commitScript = remoteScriptVersionDelivery(existingRef?.session, authorized);
  try {
    const response = await dispatch({
      ...req,
      internal: {
        ...req.internal,
        sessionAuthorityActive: () => active,
        onSessionPublished: (commit) => {
          commitScript = commit;
        },
      },
    });
    return commitScript(response);
  } finally {
    active = false;
  }
}
