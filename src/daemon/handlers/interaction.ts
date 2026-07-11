import type { DaemonResponse, SessionState } from '../types.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import { handleTouchInteractionCommands } from './interaction-touch.ts';
import { captureSnapshotForSession } from './interaction-snapshot.ts';
import { refSnapshotFlagGuardResponse } from './interaction-flags.ts';
import { dispatchGetViaRuntime, dispatchIsViaRuntime } from '../selector-runtime.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import { finalizeTouchInteraction } from './interaction-common.ts';
import { errorResponse, noActiveSessionError, requireCommandSupported } from './response.ts';
import { PUBLIC_COMMANDS } from '../../command-catalog.ts';
import { normalizeError } from '../../kernel/errors.ts';
import { successText } from '../../utils/success-text.ts';
import {
  ensureAndroidBlockingSystemDialogReady,
  recoverAndroidBlockingSystemDialog,
} from '../android-system-dialog.ts';
import { dispatchGestureViaRuntime, dispatchSwipeViaRuntime } from './interaction-gesture.ts';

export async function handleInteractionCommands(
  params: InteractionHandlerParams,
): Promise<DaemonResponse | null> {
  const touchResponse = await handleTouchInteractionCommands({
    ...params,
    captureSnapshotForSession,
    refSnapshotFlagGuardResponse,
  });
  if (touchResponse) {
    return touchResponse;
  }

  switch (params.req.command) {
    case PUBLIC_COMMANDS.gesture:
      return await dispatchGestureViaRuntime({
        ...params,
        captureSnapshotForSession,
      });
    case PUBLIC_COMMANDS.swipe:
      return await dispatchSwipeViaRuntime({
        ...params,
        captureSnapshotForSession,
      });
    case PUBLIC_COMMANDS.type:
      return await dispatchTypeViaRuntime({
        ...params,
        captureSnapshotForSession,
      });
    case 'get':
      return await dispatchGetViaRuntime(params);
    case 'is':
      return await dispatchIsViaRuntime(params);
    default:
      return null;
  }
}

async function dispatchTypeViaRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: typeof captureSnapshotForSession;
  },
): Promise<DaemonResponse> {
  const { sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (!session) return noActiveSessionError();
  const unsupported = requireCommandSupported(PUBLIC_COMMANDS.type, session.device);
  if (unsupported) return unsupported;
  const recordingRecoveryResponse = await recoverAndroidRecordingDialogForType(session);
  if (recordingRecoveryResponse) return recordingRecoveryResponse;

  return await runTypeTextViaRuntime(params, session);
}

async function recoverAndroidRecordingDialogForType(
  session: SessionState,
): Promise<DaemonResponse | null> {
  if (session.device.platform === 'android' && session.recording) {
    const androidRecoveryResult = await recoverAndroidBlockingSystemDialog({ session });
    if (androidRecoveryResult.status === 'failed') {
      return errorResponse('COMMAND_FAILED', 'Android system dialog blocked the recording session');
    }
  }
  return null;
}

async function runTypeTextViaRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: typeof captureSnapshotForSession;
  },
  session: SessionState,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const text = (req.positionals ?? []).join(' ');
  const runtime = createInteractionRuntime(params);
  const actionStartedAt = Date.now();
  try {
    const readiness = await ensureAndroidBlockingSystemDialogReady({
      session,
      command: req.command,
      phase: 'before-command',
    });
    const result = await runtime.interactions.typeText(text, {
      session: sessionName,
      requestId: req.meta?.requestId,
      delayMs: req.flags?.delayMs,
    });
    await ensureAndroidBlockingSystemDialogReady({
      session,
      command: req.command,
      phase: 'after-command',
    });
    const actionFinishedAt = Date.now();
    const responseData: Record<string, unknown> = {
      ...(result.backendResult ?? {}),
      text: result.text,
      delayMs: result.delayMs,
      ...successText(result.message ?? `Typed ${Array.from(result.text).length} chars`),
    };
    if (readiness.status === 'recovered') responseData.warning = readiness.warning;
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
