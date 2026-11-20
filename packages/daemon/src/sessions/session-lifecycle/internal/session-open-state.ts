import type { AndroidEmulatorLaunchIdentity } from '@agent-device/contracts/device-readiness-runtime';
import type { CloseBootOwnership } from '@agent-device/contracts/device-boot';
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
  /** #4162: who owns stopping this device, and what close must say when nobody proved a boot. */
  bootOwnership: CloseBootOwnership;
  androidLaunchIdentity?: AndroidEmulatorLaunchIdentity;
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
    bootOwnership,
  } = params;
  requireOpenSessionAdmission(store, sessionName, existingRef);
  if (existingRef) {
    store.updateOpenDevice(existingRef, device, bootOwnership, params.androidLaunchIdentity);
    const session = store.update(existingRef, {
      surface,
      appBundleId,
      appName,
    });
    session.lease = resolveSessionLeaseForRequest({ req, existingLease: session.lease });
    if (deviceClaim) session.deviceClaim = deviceClaim;
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
  // The store decides what each ownership answer records; a fresh draft carries the device already,
  // and 'none' writes nothing but its absence. No second copy of that rule belongs here.
  store.updateOpenDevice(ref, device, bootOwnership, params.androidLaunchIdentity);
  return store.refresh(ref);
}
