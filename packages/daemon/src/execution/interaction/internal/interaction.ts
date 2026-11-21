import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { SessionRef, SessionState } from '../../../core/session-state.ts';
import {
  type RequestCaptureProof,
  withCaptureDisclosures,
} from '../../../core/capture-disclosure.ts';
import type {
  CaptureSnapshotForSession,
  InteractionRouteInput,
} from '../../../core/interaction/internal/types.ts';
import { dispatchFillViaRuntime } from './interaction-touch-fill.ts';
import { dispatchTargetedTouchViaRuntime } from './interaction-touch-press.ts';
import { finalizeTouchInteraction } from './interaction-runtime.ts';
import { refSnapshotFlagGuardResponse } from '../../ref-snapshot-flag-policy.ts';
import { dispatchGetViaRuntime, dispatchIsViaRuntime } from '../../selector-runtime.ts';
import { expireRefFrame } from '../../../core/ref-frame.ts';
import { PUBLIC_COMMANDS } from '@agent-device/command-registry/catalog';
import { normalizeError } from '@agent-device/kernel/errors';
import {
  ensureAndroidBlockingSystemDialogReady,
  recoverAndroidBlockingSystemDialog,
} from '../../android-system-dialog.ts';
import { dispatchGestureViaRuntime, dispatchSwipeViaRuntime } from './interaction-gesture.ts';
import {
  parseTypeTextRequest,
  resolveBoundTypeTextRuntime,
  type TypeTextRequest,
} from '../../type-text-runtime.ts';
import { readTypeTextFromPositionals } from '@agent-device/selectors/interaction-positionals';
import { errorResponse, noActiveSessionError } from '@agent-device/kernel/contracts';

export async function handleInteractionCommands(
  params: InteractionRouteInput & {
    sessionRef: SessionRef | undefined;
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
): Promise<DaemonResponse | null> {
  const captureProof: RequestCaptureProof = {};
  const sessionRef = params.sessionRef;
  const routed = { ...params, sessionRef, refSnapshotFlagGuardResponse, captureProof };
  const response = await dispatchInteractionCommand(routed);
  return response
    ? withCaptureDisclosures({ response, consumedTree: captureProof, captureProof })
    : response;
}

type RoutedInteractionInput = InteractionRouteInput & {
  captureSnapshotForSession: CaptureSnapshotForSession;
  refSnapshotFlagGuardResponse: typeof refSnapshotFlagGuardResponse;
};

async function dispatchInteractionCommand(
  params: RoutedInteractionInput,
): Promise<DaemonResponse | null> {
  switch (params.req.command) {
    case 'press':
      return await dispatchTargetedTouchViaRuntime(params, 'press');
    case 'click':
      return await dispatchTargetedTouchViaRuntime(params, 'click');
    case 'longpress':
      return await dispatchTargetedTouchViaRuntime(params, 'longpress');
    case 'hover':
      return await dispatchTargetedTouchViaRuntime(params, 'hover');
    case 'fill':
      return await dispatchFillViaRuntime(params);
    default:
      return await dispatchNonTouchInteractionCommand(params);
  }
}

/**
 * The commands that do not aim a gesture at a captured target. They are a separate question from the
 * touch dispatch above, which ADR 0011 holds to one delegation per case.
 */
async function dispatchNonTouchInteractionCommand(
  params: RoutedInteractionInput,
): Promise<DaemonResponse | null> {
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

async function dispatchTypeViaRuntime(params: RoutedInteractionInput): Promise<DaemonResponse> {
  const { sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (!session) return noActiveSessionError();
  const context = params.contextFromFlags(
    params.req.flags,
    session.appBundleId,
    session.trace?.outPath,
  );
  // The optional leading target splits off before any validation, so a targeted request refuses
  // its text problems before the focus tap crosses to the device. `readTypeTextFromPositionals`
  // leads a target only with a minted snapshot ref, so lookalike words, selector keys, and
  // number pairs stay text (#4360); a real ref with no text is the mistargeted `fill` it usually
  // is and is refused below, still before any dispatch.
  const decoded = readTypeTextFromPositionals(params.req.positionals ?? []);
  if (decoded.target !== undefined && decoded.textPositionals.length === 0) {
    return missingTypeTextResponse(decoded.target.ref);
  }
  // An invalid request is refused before binding, dialog recovery, and ref-frame expiry, so the
  // `fill @eN` hint of a mistargeted ref still names a live ref.
  let request: TypeTextRequest;
  try {
    request = parseTypeTextRequest(decoded.textPositionals, context, {
      rejectRefTarget: decoded.target === undefined,
    });
  } catch (error) {
    return { ok: false, error: normalizeError(error) };
  }
  // R41: exact-owner facts admission replaces the capability bucket, and the one binding made
  // here is the only way this request's text can reach a device. It admits before the focus tap,
  // so a refused targeted `type` never taps the device (#4870 review).
  const bound = await resolveBoundTypeTextRuntime({
    device: session.device,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return bound.response;
  const recordingRecovery = await recoverAndroidRecordingDialogForType(
    session,
    params.androidObservation,
  );
  if (recordingRecovery.response) return recordingRecovery.response;
  // A targeted `type` is one command with two device effects: the press admission stack
  // (resolution, AMBIGUOUS_MATCH, motion and keyboard guards) focuses the target first, then the
  // bound text-entry operation appends. The leg dispatches and records as `press` — the command
  // it performs — so the recorded script replays one tap and then the append, and the recorded
  // type step carries the text as one positional that replay cannot re-split into a target
  // (#4870 review).
  let focusedTarget: Record<string, unknown> | undefined;
  if (decoded.target) {
    const focusResponse = await dispatchTargetedTouchViaRuntime(
      {
        ...params,
        req: { ...params.req, command: 'press', positionals: decoded.targetPositionals },
      },
      'press',
    );
    if (!focusResponse.ok) return focusResponse;
    focusedTarget = focusResponse.data;
  }

  return await runTypeTextViaRuntime(params, session, {
    typeText: () => bound.typeText(request, context),
    recordingRecoveryWarning: recordingRecovery.warning,
    focusedTarget,
    recordedPositionals: [decoded.textPositionals.join(' ')],
  });
}

/** #4360: a leading snapshot ref with no text is a mistargeted `fill`, not a targetless type. */
function missingTypeTextResponse(ref: string): DaemonResponse {
  return errorResponse('INVALID_ARGS', `type ${ref} requires text to append`, undefined, {
    hint: `Pass the text: type ${ref} "text". Use fill ${ref} "text" to replace the field content.`,
  });
}

/** The target identity the focus tap resolved, reported beside the text it typed into. */
function typeTargetResponseFields(
  data: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!data) return {};
  const fields: Record<string, unknown> = {};
  if (typeof data.targetKind === 'string') fields.targetKind = data.targetKind;
  if (typeof data.ref === 'string') fields.ref = data.ref;
  if (typeof data.refLabel === 'string') fields.refLabel = data.refLabel;
  return fields;
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
  {
    typeText,
    recordingRecoveryWarning,
    focusedTarget,
    recordedPositionals,
  }: {
    typeText: () => Promise<Record<string, unknown>>;
    recordingRecoveryWarning?: string;
    /** Target identity from the focus tap of a targeted `type`, reported with the text. */
    focusedTarget?: Record<string, unknown>;
    /** The text as one positional, so a replayed step cannot re-split it into a target. */
    recordedPositionals?: string[];
  },
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
    // executing so a later step cannot reuse it. The request was validated before this point.
    expireRefFrame(session);
    const result = await typeText();
    await ensureAndroidBlockingSystemDialogReady({
      session,
      command: req.command,
      phase: 'after-command',
      observation: params.androidObservation,
    });
    const actionFinishedAt = Date.now();
    const responseData: Record<string, unknown> = {
      ...result,
      ...typeTargetResponseFields(focusedTarget),
    };
    appendTypeReadinessWarnings(responseData, recordingRecoveryWarning, readiness);
    return finalizeTouchInteraction({
      ref: params.sessionRef!,
      sessionStore,
      command: req.command,
      positionals: recordedPositionals ?? req.positionals ?? [],
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
