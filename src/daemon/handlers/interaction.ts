import type { DaemonResponse, SessionState } from '../types.ts';
import type { InteractionRouteInput } from '../interaction/index.ts';
import { handleTouchInteractionCommands } from './interaction-touch.ts';
import {
  captureSnapshotForSession,
  finalizeTouchInteraction,
  refSnapshotFlagGuardResponse,
} from '../interaction/index.ts';
import { dispatchGetViaRuntime, dispatchIsViaRuntime } from '../selector-runtime.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { errorResponse, noActiveSessionError } from '../response.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  ensureAndroidBlockingSystemDialogReady,
  recoverAndroidBlockingSystemDialog,
} from '../android-system-dialog.ts';
import { dispatchGestureViaRuntime, dispatchSwipeViaRuntime } from './interaction-gesture.ts';
import { resolveBoundTypeTextRuntime, type BoundTypeTextExecutor } from '../type-text-runtime.ts';

export async function handleInteractionCommands(
  params: InteractionRouteInput,
): Promise<DaemonResponse | null> {
  const touchResponse = await handleTouchInteractionCommands({
    ...params,
    captureSnapshotForSession: params.captureSnapshotForSession ?? captureSnapshotForSession,
    refSnapshotFlagGuardResponse,
  });
  if (touchResponse) {
    return touchResponse;
  }

  switch (params.req.command) {
    case PUBLIC_COMMANDS.gesture:
      return await dispatchGestureViaRuntime(params);
    case PUBLIC_COMMANDS.swipe:
      return await dispatchSwipeViaRuntime(params);
    case PUBLIC_COMMANDS.type:
      return await dispatchTypeViaRuntime(params);
    case 'get':
      return await dispatchGetViaRuntime(params);
    case 'is':
      return await dispatchIsViaRuntime(params);
    default:
      return null;
  }
}

async function dispatchTypeViaRuntime(params: InteractionRouteInput): Promise<DaemonResponse> {
  const { sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (!session) return noActiveSessionError();
  // R41: exact-owner facts admission replaces the capability bucket, and the one binding made
  // here is the only way this request's text can reach a device.
  const bound = await resolveBoundTypeTextRuntime({
    device: session.device,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return bound.response;
  const recordingRecovery = await recoverAndroidRecordingDialogForType(
    session,
    params.androidObservation,
  );
  if (recordingRecovery.response) return recordingRecovery.response;

  return await runTypeTextViaRuntime(params, session, bound.typeText, recordingRecovery.warning);
}

type AndroidRecordingDialogRecovery = {
  response?: DaemonResponse;
  warning?: string;
};

async function recoverAndroidRecordingDialogForType(
  session: SessionState,
  observation:
    | import('@agent-device/contracts/android-observation').AndroidObservationAdapter
    | undefined,
): Promise<AndroidRecordingDialogRecovery> {
  if (session.device.platform === 'android' && session.screenRecording) {
    const androidRecoveryResult = await recoverAndroidBlockingSystemDialog({
      session,
      observation,
    });
    if (androidRecoveryResult.status === 'failed') {
      return {
        response: errorResponse(
          'COMMAND_FAILED',
          'Android system dialog blocked the recording session',
        ),
      };
    }
    if (androidRecoveryResult.status === 'unknown') {
      return { warning: androidRecoveryResult.warning };
    }
  }
  return {};
}

async function runTypeTextViaRuntime(
  params: InteractionRouteInput,
  session: SessionState,
  boundTypeText: BoundTypeTextExecutor,
  recordingRecoveryWarning?: string,
): Promise<DaemonResponse> {
  const { req, sessionStore } = params;
  const actionStartedAt = Date.now();
  try {
    const readiness = await ensureAndroidBlockingSystemDialogReady({
      session,
      command: req.command,
      phase: 'before-command',
      observation: params.androidObservation,
    });
    // ADR 0014 side-effect seam: the entry mutates the focused field; expire the frame before
    // executing so a later step cannot reuse it. R41: the bound executor already validates and
    // composes the retired leaf's exact result, so nothing here re-validates or re-formats it.
    expireRefFrame(session);
    const result = await boundTypeText(
      req.positionals ?? [],
      params.contextFromFlags(req.flags, session.appBundleId, session.trace?.outPath),
    );
    await ensureAndroidBlockingSystemDialogReady({
      session,
      command: req.command,
      phase: 'after-command',
      observation: params.androidObservation,
    });
    const actionFinishedAt = Date.now();
    const responseData: Record<string, unknown> = { ...result };
    appendTypeReadinessWarnings(responseData, recordingRecoveryWarning, readiness);
    return finalizeTouchInteraction({
      session,
      sessionStore,
      command: req.command,
      positionals: req.positionals ?? [],
      flags: req.flags,
      result: responseData,
      responseData,
      actionStartedAt,
      actionFinishedAt,
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
}

function appendTypeReadinessWarnings(
  responseData: Record<string, unknown>,
  recordingRecoveryWarning: string | undefined,
  readiness: Awaited<ReturnType<typeof ensureAndroidBlockingSystemDialogReady>>,
): void {
  const warnings = [
    typeof responseData.warning === 'string' ? responseData.warning : undefined,
    recordingRecoveryWarning,
  ];
  if (readiness.status === 'recovered') warnings.push(readiness.warning);
  const composedWarning = warnings
    .filter((warning): warning is string => typeof warning === 'string' && warning.length > 0)
    .join(' ');
  if (composedWarning.length > 0) responseData.warning = composedWarning;
}
