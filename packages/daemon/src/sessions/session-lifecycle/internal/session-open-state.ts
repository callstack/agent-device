import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { sessionHasOwnersBeyondRecording, type SessionRef } from '../../../core/session-state.ts';
import { AppError } from '@agent-device/kernel/errors';
import type { SessionStore } from '../../../core/session-store.ts';
import type { DeviceClaimSessionOwnership } from '@agent-device/daemon-contracts/device-claims';
import { clearSessionSnapshot } from '../../../execution/session-snapshot.ts';
import { resolveSessionLeaseForRequest } from '../../lease-lifecycle.ts';
import { resolvePublicSessionName, resolveSessionScope } from '../../session-routing.ts';

export function requireOpenSessionAdmission(
  store: SessionStore,
  address: string,
  ref: SessionRef | undefined,
): void {
  if (ref) {
    store.assertAdmissionOpen(ref.address);
    store.requireCurrent(ref);
  } else {
    store.assertPublishable(address);
  }
}

export function publishOpenSession(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  existingRef?: SessionRef;
  device: DeviceInfo;
  surface: SessionSurface;
  appBundleId?: string;
  appName?: string;
  deviceClaim?: DeviceClaimSessionOwnership;
}): SessionRef {
  const {
    req,
    sessionStore: store,
    sessionName,
    existingRef,
    device,
    surface,
    appBundleId,
    appName,
    deviceClaim,
  } = params;
  requireOpenSessionAdmission(store, sessionName, existingRef);
  if (existingRef) {
    const session = store.update(existingRef, {
      device,
      surface,
      appBundleId,
      appName,
    });
    session.lease = resolveSessionLeaseForRequest({ req, existingLease: session.lease });
    if (deviceClaim) session.deviceClaim = deviceClaim;
    clearSessionSnapshot(session);
    return store.refresh(existingRef);
  }
  return store.publish(sessionName, {
    name: resolvePublicSessionName(req),
    sessionScope: req.internal?.resolvedSessionScope ?? resolveSessionScope(req),
    device,
    surface,
    appBundleId,
    appName,
    createdAt: Date.now(),
    actions: [],
    lease: resolveSessionLeaseForRequest({ req }),
    deviceClaim,
  });
}

export function adoptRecordOnlyRecordingClaim(
  store: SessionStore,
  ref: SessionRef,
  ownership: DeviceClaimSessionOwnership,
): void {
  const session = store.requireCurrent(ref);
  if (!session.recordOnlySession) return;
  if (session.deviceClaim && session.deviceClaim.ownerToken !== ownership.ownerToken)
    throw new AppError('COMMAND_FAILED', 'Recording device claim changed', {
      reason: 'ownership-fence-lost',
    });
  session.deviceClaim = ownership;
}

export function releaseRecordOnlyRecordingClaim(
  store: SessionStore,
  address: string,
  ownership: DeviceClaimSessionOwnership,
): void {
  const ref = store.lookup(address);
  const session = ref?.session;
  if (
    !ref ||
    !session?.recordOnlySession ||
    session.deviceClaim?.ownerToken !== ownership.ownerToken
  )
    return;
  session.deviceClaim = undefined;
  if (!session.screenRecording && !sessionHasOwnersBeyondRecording(session)) store.retire(ref);
}
