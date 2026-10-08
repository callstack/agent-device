import type { HostEnvironment } from '@agent-device/kernel/source-value';
import { isMacOs, type DeviceInfo } from '@agent-device/kernel/device';
import {
  errorResponse,
  type DaemonResponse,
  type DaemonFailureResponse,
} from '@agent-device/kernel/contracts';
import { isDeepLinkTarget } from '@agent-device/contracts/command';
import { readMacOsAppBackend, type SessionSurface } from '@agent-device/contracts/session';
import {
  acquireDeviceClaim,
  type DeviceClaimApp,
  type DeviceClaimAcquireResult,
  type DeviceClaimSessionOwnership,
  type DeviceClaimReconciler,
  type TakenOverDeviceClaim,
} from '@agent-device/daemon-contracts/device-claims';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { DaemonPlatformServices } from '../../../core/platform-services.ts';
import type { SessionState } from '../../../core/session-state.ts';
import type { SessionStore } from '../../../core/session-store.ts';
import {
  buildDeviceInUseBySessionError,
  buildForeignWorkspaceSessionConflict,
} from '../../../core/session-recovery-hints.ts';
import {
  admittedLeaseApp,
  describeOpenWaitForRefusal,
  isSameApp,
  sessionConflictsWithOpen,
} from '../../open-device-contention-wait.ts';
import { isImplicitSessionScopeConflict } from '../../session-routing.ts';
import { buildDeviceClaimConflictError } from '../../../resources/device/device-claim-conflict.ts';
import { deviceClaimRuleForOwner } from '../../../resources/device/device-claim-rule.ts';
import type { OpenApplicationRuntime } from './session-open-execution.ts';

/**
 * The refusal an open gets when another session already holds a conflicting part of the device.
 * The wait an expired `--wait` budget spent is carried into the recovery text, because a caller
 * that waited is not helped by being told to wait.
 */
function findNewSessionDeviceConflict(params: {
  req: DaemonRequest;
  device: DeviceInfo;
  sessionStore: SessionStore;
  openerApp: DeviceClaimApp | undefined;
}): DaemonFailureResponse | undefined {
  const { req, device, sessionStore, openerApp } = params;
  const inUse = sessionStore
    .listRefs()
    .find(
      (ref) =>
        ref.session.device.id === device.id && sessionConflictsWithOpen(ref.session, openerApp),
    );
  if (!inUse) return undefined;
  req.internal?.reportOpenDeviceConflict?.(openerApp);
  // The wait the caller paid for belongs to `open` alone: an interaction that hits the same busy
  // device cannot wait for it, and would be sent off with a flag its own command rejects.
  const attempt = describeOpenWaitForRefusal(req);
  if (isImplicitSessionScopeConflict(req, inUse.session)) {
    return buildForeignWorkspaceSessionConflict(inUse, device, attempt);
  }
  return buildDeviceInUseBySessionError(inUse, device, attempt);
}

/**
 * The app a native macOS app session claims instead of the whole Mac (ADR 0035). The native
 * backend acts on the session app alone, so another session may drive another app. Every other
 * macOS session, an open whose app is not known before launch, and a `macos-app` lease (which
 * takes no claim) get no app claim.
 */
async function resolveAppClaim(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  device: DeviceInfo;
  surface: SessionSurface;
  openTarget: string | undefined;
  lifecycle: OpenApplicationRuntime;
}): Promise<DeviceClaimApp | undefined> {
  const { req, device, surface, openTarget, lifecycle } = params;
  if (
    !isMacOs(device) ||
    surface !== 'app' ||
    !openTarget ||
    isDeepLinkTarget(openTarget) ||
    deviceClaimRuleForOwner(lifecycle.owner, req.internal?.admittedLease) !== 'ordinary' ||
    readMacOsAppBackend((name) => params.host.env[name]) !== 'native'
  ) {
    return undefined;
  }
  const { appBundleId } = await lifecycle.operations.resolveOpenTarget({
    target: openTarget,
    surface,
    foreground: false,
  });
  return appBundleId ? { bundleId: appBundleId } : undefined;
}

/**
 * A session that holds an app claim may reopen only that app on the app surface: anything else
 * would drive what its claim does not cover.
 */
export function reopenOutsideAppClaim(params: {
  session: SessionState;
  surface: SessionSurface;
  appBundleId: string | undefined;
}): DaemonResponse | undefined {
  const { session, surface, appBundleId } = params;
  const heldApp = session.deviceClaim?.app;
  if (!heldApp) return undefined;
  if (
    surface === 'app' &&
    appBundleId !== undefined &&
    isSameApp(heldApp, { bundleId: appBundleId })
  ) {
    return undefined;
  }
  return errorResponse(
    'INVALID_ARGS',
    `Session "${session.name}" holds ${heldApp.bundleId} only, so it can reopen only that app on the app surface.`,
    {
      reason: 'app-claim-scope',
      deviceKey: session.deviceClaim?.deviceKey,
      hint: `To open a link in this app, name the app: open ${heldApp.bundleId} <url>. For another app or surface, close this session or use a new --session.`,
    },
  );
}

/** The claim was taken for the app resolved before preparation; the open must launch that app. */
export function openedOutsideAppClaim(
  app: DeviceClaimApp | undefined,
  resolved: string | undefined,
  openTarget: string | undefined,
): DaemonResponse | undefined {
  if (!app || (resolved !== undefined && isSameApp(app, { bundleId: resolved }))) return undefined;
  return errorResponse(
    'COMMAND_FAILED',
    `${openTarget ?? 'The app'} resolved to ${resolved ?? 'no app'} after its claim was taken for ${app.bundleId}.`,
    { reason: 'app-claim-scope', hint: 'Run the same open again.' },
  );
}

async function acquireDeviceClaimForOwner(params: {
  host: HostEnvironment;
  req: DaemonRequest;
  device: DeviceInfo;
  owner: OpenApplicationRuntime['owner'];
  sessionName: string;
  sessionStore: SessionStore;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
  platformServices: DaemonPlatformServices;
  app: DeviceClaimApp | undefined;
}): Promise<DeviceClaimAcquireResult | { status: 'not-required' }> {
  const {
    req,
    device,
    owner,
    sessionName,
    sessionStore,
    reconcileOrphanedDeviceClaim,
    app,
    platformServices,
  } = params;
  switch (deviceClaimRuleForOwner(owner, req.internal?.admittedLease)) {
    case 'none':
      return { status: 'not-required' };
    case 'ordinary':
      return await acquireDeviceClaim({
        device,
        session: sessionName,
        workspace: req.meta?.cwd ?? params.host.cwd,
        stateDir: sessionStore.resolveDaemonStateDir(),
        env: params.host.env,
        reconcileOrphanedDeviceClaim,
        observeDeviceBoot: platformServices.deviceBootObservation,
        ...(app ? { app } : {}),
      });
  }
}

/** Takes the claim a new session needs: its app's, or the whole device's. */
export async function claimNewSessionDevice(params: {
  host: HostEnvironment;
  platformServices: DaemonPlatformServices;
  req: DaemonRequest;
  device: DeviceInfo;
  surface: SessionSurface;
  openTarget: string | undefined;
  lifecycle: OpenApplicationRuntime;
  sessionName: string;
  sessionStore: SessionStore;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<
  | { response: DaemonResponse }
  | {
      app: DeviceClaimApp | undefined;
      deviceClaim: DeviceClaimSessionOwnership | undefined;
      tookOverDeviceClaim: TakenOverDeviceClaim | undefined;
    }
> {
  const { req, device, lifecycle, sessionStore } = params;
  const app = await resolveAppClaim(params);
  const conflict = findNewSessionDeviceConflict({
    req,
    device,
    sessionStore,
    openerApp: admittedLeaseApp(req.internal?.admittedLease) ?? app,
  });
  if (conflict) return { response: conflict };
  const ownerClaim = await acquireDeviceClaimForOwner({ ...params, owner: lifecycle.owner, app });
  if (ownerClaim.status === 'conflict') {
    return { response: buildDeviceClaimConflictError(device, ownerClaim.conflict) };
  }
  return ownerClaim.status === 'acquired'
    ? { app, deviceClaim: ownerClaim.ownership, tookOverDeviceClaim: ownerClaim.tookOver }
    : { app, deviceClaim: undefined, tookOverDeviceClaim: undefined };
}
