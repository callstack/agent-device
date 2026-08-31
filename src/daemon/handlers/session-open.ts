import { resolveTargetDeviceSelection } from '../../core/dispatch-resolve.ts';
import {
  openApplicationRuntimeUse,
  openApplicationWithRuntimeHintApplyAndClearUse,
  openApplicationWithRuntimeHintApplyUse,
  openApplicationWithRuntimeHintClearUse,
  resolveOpenApplicationRuntimePlan,
} from '@agent-device/contracts/application-lifecycle-runtime-plan';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { refreshSessionDeviceIfNeeded } from '../session-device-resolution.ts';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { buildOpenTargetDeviceResolutionOptions } from '../open-device-selection.ts';
import {
  invalidOpenArgs,
  prepareOpenCommandDetails,
  resolveOpenRuntimeHintPlan,
  resolveOpenSurfaceResponse,
  type ResolvedOpenRuntimeHintPlan,
  validatePreResolvedOpenRequest,
  validateResolvedOpenRequest,
} from './session-open-prepare.ts';
import { resolveForegroundOpenRequest } from './session-open-foreground.ts';
import { errorResponse } from './response.ts';
import { expireRefFrame } from '../ref-frame.ts';
import type { DeviceClaimReconciler } from '../device-claims.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import { admitRuntimeOperations } from '../runtime-admission.ts';
import { resolveExistingSessionDeviceSelection } from '../../core/device-selection-resolver.ts';
import {
  completeOpenCommand,
  openNewSessionWithDeviceClaim,
  type OpenApplicationRuntime,
  type RuntimeHintApplyOperation,
  type RuntimeHintClearOperation,
} from './session-open-execution.ts';

export { buildDeviceInUseBySessionError } from './session-open-execution.ts';

const firstSessionOpenLocks = new Map<string, Promise<unknown>>();

type OpenRuntimeAdmission =
  | Readonly<{
      type: 'runtime';
      runtime: OpenApplicationRuntime;
      applyRuntimeHints?: RuntimeHintApplyOperation;
      clearRuntimeHints?: RuntimeHintClearOperation;
    }>
  | Readonly<{ type: 'response'; response: DaemonResponse }>;

type OpenRuntimePlanAdmission =
  | Readonly<{ type: 'response'; response: DaemonResponse }>
  | Readonly<{
      type: 'runtime';
      runtimeHintPlan: ResolvedOpenRuntimeHintPlan;
      admission: Extract<OpenRuntimeAdmission, { type: 'runtime' }>;
    }>;

// The sole facts admission and binding seam for this handler. Facts are side-effect free; the
// implementation remains unavailable until all required facts admit the selected owner. Only the
// exact bind differs per plan, so each `open` use keeps its precise operation projection.
async function admitOpenRuntime(params: {
  device: DeviceInfo;
  runtimeHintPlan: ResolvedOpenRuntimeHintPlan;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<OpenRuntimeAdmission> {
  const plan = resolveOpenApplicationRuntimePlan({
    applyRuntimeHints: params.runtimeHintPlan.applyRuntimeHints,
    clearRemovedRuntimeHints: params.runtimeHintPlan.clearRemovedRuntimeHints,
  });
  const admitted = await admitRuntimeOperations({
    ...params,
    command: 'open',
    required: plan.use.required,
  });
  if (admitted.type === 'response') return admitted;
  const bind = admitted.bind;
  switch (plan.kind) {
    case 'open': {
      const runtime = await bind(params.device, openApplicationRuntimeUse);
      return { type: 'runtime', runtime };
    }
    case 'open-apply-runtime-hints': {
      const runtime = await bind(params.device, openApplicationWithRuntimeHintApplyUse);
      return {
        type: 'runtime',
        runtime,
        applyRuntimeHints: runtime.operations.applyRuntimeHints,
      };
    }
    case 'open-clear-runtime-hints': {
      const runtime = await bind(params.device, openApplicationWithRuntimeHintClearUse);
      return {
        type: 'runtime',
        runtime,
        clearRuntimeHints: runtime.operations.clearRuntimeHints,
      };
    }
    case 'open-apply-and-clear-runtime-hints': {
      const runtime = await bind(params.device, openApplicationWithRuntimeHintApplyAndClearUse);
      return {
        type: 'runtime',
        runtime,
        applyRuntimeHints: runtime.operations.applyRuntimeHints,
        clearRuntimeHints: runtime.operations.clearRuntimeHints,
      };
    }
  }
}

async function resolveOpenRuntimePlanAdmission(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  device: DeviceInfo;
  existingSession?: SessionState;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<OpenRuntimePlanAdmission> {
  const runtimeHintPlan = resolveOpenRuntimeHintPlan(params);
  if (runtimeHintPlan.type === 'response') return runtimeHintPlan;
  const admission = await admitOpenRuntime({
    device: params.device,
    runtimeHintPlan: runtimeHintPlan.plan,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (admission.type === 'response') return admission;
  return { type: 'runtime', runtimeHintPlan: runtimeHintPlan.plan, admission };
}

// fallow-ignore-next-line complexity
export async function handleOpenCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
  reconcileOrphanedDeviceClaim: DeviceClaimReconciler;
}): Promise<DaemonResponse> {
  const { sessionName, logPath, sessionStore } = params;

  const session = sessionStore.get(sessionName);
  const foregroundResolution = await resolveForegroundOpenRequest({
    req: params.req,
    hasExistingSession: Boolean(session),
  });
  if (foregroundResolution.type === 'response') return foregroundResolution.response;
  const req = foregroundResolution.type === 'resolved' ? foregroundResolution.req : params.req;

  if (session) {
    if (req.flags?.saveScript) {
      return errorResponse(
        'INVALID_ARGS',
        'open --save-script can only arm a fresh session. Use the current session without --save-script, or close it and start a fresh session.',
      );
    }
    const shouldRelaunch = req.flags?.relaunch === true;
    const requestedOpenTarget = req.positionals?.[0];
    const openTarget = requestedOpenTarget ?? (shouldRelaunch ? session.appName : undefined);
    const surfaceResult = resolveOpenSurfaceResponse(
      session.device,
      req.flags?.surface,
      openTarget,
      session.surface,
    );
    if (typeof surfaceResult !== 'string') {
      return surfaceResult;
    }
    if (!openTarget && surfaceResult === 'app') {
      return shouldRelaunch
        ? invalidOpenArgs('open --relaunch requires an app name or an active session app.')
        : invalidOpenArgs('Session already active. Close it first or pass a new --session name.');
    }

    const validation = await validateResolvedOpenRequest({
      shouldRelaunch,
      openTarget,
      surface: surfaceResult,
      device: session.device,
    });
    if (validation) {
      return validation;
    }

    const device = await refreshSessionDeviceIfNeeded(session.device);
    const selection = resolveExistingSessionDeviceSelection(device);
    await req.internal?.retainDeviceExecutionLock?.(device.id);
    const runtimePlanAdmission = await resolveOpenRuntimePlanAdmission({
      req,
      sessionStore,
      sessionName,
      device,
      existingSession: session,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
    if (runtimePlanAdmission.type === 'response') return runtimePlanAdmission.response;
    const { admission, runtimeHintPlan } = runtimePlanAdmission;
    // The preparation can boot a device, clear native hints, or warm a runner. An existing
    // frame becomes stale before those effects, rather than after the later visible launch.
    expireRefFrame(session);
    const details = await prepareOpenCommandDetails({
      req,
      logPath,
      surface: surfaceResult,
      openTarget,
      existingSession: session,
      runtime: admission.runtime,
      runtimeHintPlan,
      clearRuntimeHints: admission.clearRuntimeHints,
      foreground: false,
    });
    if (details.type === 'response') {
      return details.response;
    }

    return await completeOpenCommand({
      req,
      sessionName,
      sessionStore,
      logPath,
      device,
      openTarget,
      openPositionals: requestedOpenTarget
        ? (req.positionals ?? [])
        : openTarget
          ? [openTarget]
          : [],
      appBundleId: details.details.appBundleId,
      appName: details.details.appName,
      runtimeHints: details.details.runtime,
      lifecycle: admission.runtime,
      applyRuntimeHints: admission.applyRuntimeHints,
      surface: surfaceResult,
      existingSession: session,
      selection,
    });
  }

  const shouldRelaunch = req.flags?.relaunch === true;
  const openTarget = req.positionals?.[0];
  if (shouldRelaunch && !openTarget) {
    return invalidOpenArgs('open --relaunch requires an app argument.');
  }

  const preResolvedValidation = await validatePreResolvedOpenRequest({
    shouldRelaunch,
    openTarget,
    platform: req.flags?.platform === 'android' ? 'android' : undefined,
  });
  if (preResolvedValidation) {
    return preResolvedValidation;
  }

  const selection = await resolveTargetDeviceSelection(
    req.flags ?? {},
    buildOpenTargetDeviceResolutionOptions(openTarget),
  );
  const device = selection.device;
  await req.internal?.retainDeviceExecutionLock?.(device.id);
  const surfaceResult = resolveOpenSurfaceResponse(device, req.flags?.surface, openTarget);
  if (typeof surfaceResult !== 'string') {
    return surfaceResult;
  }

  const validation = await validateResolvedOpenRequest({
    shouldRelaunch,
    openTarget,
    surface: surfaceResult,
    device,
  });
  if (validation) {
    return validation;
  }

  const runtimePlanAdmission = await resolveOpenRuntimePlanAdmission({
    req,
    sessionStore,
    sessionName,
    device,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (runtimePlanAdmission.type === 'response') return runtimePlanAdmission.response;
  const { admission, runtimeHintPlan } = runtimePlanAdmission;

  return await withKeyedLock(
    firstSessionOpenLocks,
    device.id,
    async () =>
      await openNewSessionWithDeviceClaim({
        req,
        sessionName,
        logPath,
        sessionStore,
        device,
        surface: surfaceResult,
        openTarget,
        lifecycle: admission.runtime,
        runtimeHintPlan,
        applyRuntimeHints: admission.applyRuntimeHints,
        clearRuntimeHints: admission.clearRuntimeHints,
        reconcileOrphanedDeviceClaim: params.reconcileOrphanedDeviceClaim,
        selection,
      }),
  );
}
