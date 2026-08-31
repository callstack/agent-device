import { isDeepLinkTarget } from '@agent-device/contracts/command';
import type { RuntimeHintsApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import { openApplicationRuntimeUse } from '@agent-device/contracts/application-lifecycle-runtime-plan';
import type { BoundDeviceRuntime } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type {
  DaemonRequest,
  DaemonResponse,
  SessionRuntimeHints,
  SessionState,
} from '../../types.ts';
import { SessionStore } from '../../session-store.ts';
import {
  resolveRequestedOpenSurface,
  validateOpenRelaunchTarget,
} from '../../../platform-runtime-open-target.ts';
import {
  hasRuntimeTransportHints,
  maybeClearRemovedRuntimeTransportHints,
  shouldClearRemovedRuntimeTransportHints,
  tryResolveOpenRuntimeHints,
} from '../../session-runtime.ts';
import { AppError } from '@agent-device/kernel/errors';
import { errorResponse } from '../../response.ts';
import type { SessionSurface } from '@agent-device/contracts/session';
import { resolveRunnerLogicalLeaseContext } from '../../lease-context.ts';

type OpenCommandDetails = {
  appBundleId?: string;
  appName?: string;
  runtime: SessionRuntimeHints | undefined;
};

export type PreparedOpenCommandDetailsResult =
  | { type: 'response'; response: DaemonResponse }
  | { type: 'details'; details: OpenCommandDetails };

type OpenApplicationRuntime = BoundDeviceRuntime<typeof openApplicationRuntimeUse>;
type ClearRuntimeHints = (input: RuntimeHintsApplicationInput) => Promise<void>;

export type ResolvedOpenRuntimeHintPlan = Readonly<{
  runtime: SessionRuntimeHints | undefined;
  previousRuntime: SessionRuntimeHints | undefined;
  replacedStoredRuntime: boolean;
  applyRuntimeHints: boolean;
  clearRemovedRuntimeHints: boolean;
}>;

export type OpenRuntimeHintPlanResult =
  | Readonly<{ type: 'response'; response: DaemonResponse }>
  | Readonly<{ type: 'plan'; plan: ResolvedOpenRuntimeHintPlan }>;

export function invalidOpenArgs(message: string): DaemonResponse {
  return errorResponse('INVALID_ARGS', message);
}

export function resolveOpenSurfaceResponse(
  device: DeviceInfo,
  surfaceFlag: string | undefined,
  openTarget: string | undefined,
  existingSurface?: SessionSurface,
): SessionSurface | DaemonResponse {
  try {
    return resolveRequestedOpenSurface({
      device,
      surfaceFlag,
      openTarget,
      existingSurface,
    });
  } catch (error) {
    return errorResponse(
      error instanceof AppError ? error.code : 'INVALID_ARGS',
      String((error as Error).message),
    );
  }
}

export async function validateResolvedOpenRequest(params: {
  shouldRelaunch: boolean;
  openTarget: string | undefined;
  surface: SessionSurface;
  device: DeviceInfo;
}): Promise<DaemonResponse | null> {
  const { shouldRelaunch, openTarget, surface, device } = params;
  if (!shouldRelaunch) return null;
  const message = await validateOpenRelaunchTarget({
    target: openTarget,
    platform: device.platform,
    surface,
  });
  return message ? invalidOpenArgs(message) : null;
}

export async function validatePreResolvedOpenRequest(params: {
  shouldRelaunch: boolean;
  openTarget: string | undefined;
  platform: DeviceInfo['platform'] | undefined;
}): Promise<DaemonResponse | null> {
  const { shouldRelaunch, openTarget, platform } = params;
  if (!shouldRelaunch) return null;
  const message = await validateOpenRelaunchTarget({ target: openTarget, platform });
  return message ? invalidOpenArgs(message) : null;
}

/**
 * Resolves daemon-owned runtime-hint policy before facts admission. It performs only request and
 * session-state reads so the selected lifecycle use can require exactly the native operations
 * this open will invoke.
 */
export function resolveOpenRuntimeHintPlan(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  device: DeviceInfo;
  existingSession?: SessionState;
}): OpenRuntimeHintPlanResult {
  const runtimeResult = tryResolveOpenRuntimeHints(params);
  if (!runtimeResult.ok) return { type: 'response', response: runtimeResult };
  const { runtime, previousRuntime, replacedStoredRuntime } = runtimeResult.data;
  return {
    type: 'plan',
    plan: {
      runtime,
      previousRuntime,
      replacedStoredRuntime,
      applyRuntimeHints: hasRuntimeTransportHints(runtime),
      clearRemovedRuntimeHints: shouldClearRemovedRuntimeTransportHints({
        replacedStoredRuntime,
        previousRuntime,
        runtime,
        session: params.existingSession,
      }),
    },
  };
}

export async function prepareOpenCommandDetails(params: {
  req: DaemonRequest;
  logPath: string;
  surface: SessionSurface;
  openTarget: string | undefined;
  existingSession?: SessionState;
  runtime: OpenApplicationRuntime;
  runtimeHintPlan: ResolvedOpenRuntimeHintPlan;
  clearRuntimeHints?: ClearRuntimeHints;
  foreground: boolean;
}): Promise<PreparedOpenCommandDetailsResult> {
  const {
    req,
    logPath,
    surface,
    openTarget,
    existingSession,
    runtime,
    runtimeHintPlan,
    clearRuntimeHints,
    foreground,
  } = params;
  await runtime.operations.prepareApplicationOpen({
    target: openTarget,
    currentAppBundleId: existingSession?.appBundleId,
    hasExistingSession: existingSession !== undefined,
    surface,
    deviceHub: req.flags?.deviceHub === true,
    prewarmRunnerOnColdBoot:
      surface === 'app' && Boolean(openTarget) && !isDeepLinkTarget(openTarget ?? ''),
    execution: {
      requestId: req.meta?.requestId,
      logPath,
      traceLogPath: existingSession?.trace?.outPath,
      verbose: req.flags?.verbose,
      iosXctestrunFile: req.flags?.iosXctestrunFile,
      iosXctestDerivedDataPath: req.flags?.iosXctestDerivedDataPath,
      iosXctestEnvDir: req.flags?.iosXctestEnvDir,
      runnerLeaseContext: resolveRunnerLogicalLeaseContext(req),
    },
  });
  const { appBundleId, appName } = await resolvePreparedOpenIdentity({
    runtime,
    surface,
    openTarget,
    existingAppBundleId: existingSession?.appBundleId,
    foreground,
  });
  if (runtimeHintPlan.clearRemovedRuntimeHints) {
    if (!clearRuntimeHints) {
      throw new AppError(
        'COMMAND_FAILED',
        'Runtime hint clear operation was not admitted for this open.',
        {
          reason: 'runtime-hints-operation-missing',
        },
      );
    }
    await maybeClearRemovedRuntimeTransportHints({
      replacedStoredRuntime: runtimeHintPlan.replacedStoredRuntime,
      previousRuntime: runtimeHintPlan.previousRuntime,
      runtime: runtimeHintPlan.runtime,
      session: existingSession,
      clearRuntimeHints,
    });
  }

  return {
    type: 'details',
    details: {
      appBundleId,
      appName,
      runtime: runtimeHintPlan.runtime,
    },
  };
}

async function resolvePreparedOpenIdentity(params: {
  runtime: OpenApplicationRuntime;
  surface: SessionSurface;
  openTarget: string | undefined;
  existingAppBundleId?: string;
  foreground: boolean;
}): Promise<{ appBundleId?: string; appName?: string }> {
  const { runtime, surface, openTarget, existingAppBundleId, foreground } = params;
  const resolved = await runtime.operations.resolveOpenTarget({
    target: openTarget,
    currentAppBundleId: existingAppBundleId,
    surface,
    foreground,
  });
  return {
    appBundleId: resolved.appBundleId,
    appName: resolved.appName,
  };
}
