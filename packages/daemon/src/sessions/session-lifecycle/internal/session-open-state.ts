import type { DeviceInfo } from '@agent-device/kernel/device';
import type { SessionSurface } from '@agent-device/contracts/session';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../../../core/session-state.ts';
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
  /** #4162: this open booted the local virtual device, so its plain close owns stopping it. */
  bootedByOpen?: boolean;
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
    bootedByOpen,
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
    // #4162: the fact is additive. A provisional publish (record-video test opens) or a re-open
    // whose device had died and was re-booted by THIS open both reach this branch; a re-open's own
    // selection never claims a boot, so an unchanged re-open cannot add or clear the fact.
    if (bootedByOpen === true) store.markOpenBootedDevice(existingRef);
    clearSessionSnapshot(session);
    return store.refresh(existingRef);
  }
  const draft: SessionState = {
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
  };
  const ref = store.publish(sessionName, draft);
  if (bootedByOpen === true) store.markOpenBootedDevice(ref);
  return ref;
}
