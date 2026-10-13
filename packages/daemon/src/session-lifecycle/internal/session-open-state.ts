import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { DaemonRequest } from '../../daemon-request.ts';
import type { SessionRef } from '../../session-state.ts';
import type { SessionStore } from '../../session-store.ts';
import type { DeviceClaimSessionOwnership } from '../../device/device-claims.ts';
import { clearSessionSnapshot } from '../../session-snapshot.ts';
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
