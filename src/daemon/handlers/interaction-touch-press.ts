import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  InteractionTarget,
  PreresolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import {
  buttonTag,
  getClickButtonValidationError,
  resolveClickButton,
} from '@agent-device/contracts/interaction';
import { publicPlatformString } from '@agent-device/kernel/device';
import type { ReplayTargetGuardDenotation } from '@agent-device/contracts/replay';
import { resolveRefStalenessWarning } from '../session-snapshot.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { assertAndroidPressStayedInApp } from './interaction-android-escape.ts';
import type { InteractionHandlerParams } from './interaction-common.ts';
import {
  readSettleRequest,
  settleFlagGuardResponse,
  type RefSnapshotFlagGuardResponse,
} from './interaction-flags.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import {
  refreshAndroidRefSnapshotIfFreshnessActive,
  type RefAdmissionContext,
} from './interaction-touch-android-readiness.ts';
import {
  dispatchDirectIosSelectorTap,
  readDirectIosSelectorTapTarget,
} from './interaction-touch-direct-ios.ts';
import { unsupportedMacOsDesktopSurfaceInteraction } from './interaction-touch-policy.ts';
import {
  buildTargetedTouchResponsePayloads,
  transformTouchResponseData,
  type TargetedTouchResult,
} from './interaction-touch-response.ts';
import { dispatchRuntimeInteraction } from './interaction-touch-runtime.ts';
import {
  formatTouchTargetLabel,
  parseLongPressTarget,
  parseTouchTarget,
  type ParsedLongPressTarget,
  type ParsedTouchTarget,
} from './interaction-touch-targets.ts';
import { errorResponse, noActiveSessionError, requireCommandSupported } from './response.ts';

/**
 * How a targeted `press`/`click`/`longpress` is admitted and executed: surface
 * and capability policy, click-option validation, `@ref` admission and
 * staleness, the direct-iOS attempt, and the runtime dispatch it delegates to.
 */

export type TargetedTouchCommand = 'press' | 'click' | 'longpress';

/** The label the user typed, which capability policy and parse errors quote. */
type TargetedTouchCommandLabel = TargetedTouchCommand;

type TargetedTouchParams = InteractionHandlerParams & {
  captureSnapshotForSession: CaptureSnapshotForSession;
  refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
};

/** What survives admission: the target this dispatch acts on and its policy context. */
type AdmittedTargetedTouch = {
  session: SessionState;
  commandLabel: TargetedTouchCommandLabel;
  clickButton: ReturnType<typeof resolveClickButton>;
  resultButtonTag: ReturnType<typeof buttonTag>;
  target: InteractionTarget;
  durationMs: number | undefined;
  staleRefsWarning: string | undefined;
  androidFreshnessBaseline: SessionState['snapshot'];
  refContext: RefAdmissionContext | undefined;
};

export async function dispatchTargetedTouchViaRuntime(
  params: TargetedTouchParams,
  command: TargetedTouchCommand,
): Promise<DaemonResponse> {
  const admission = await admitTargetedTouch(params, command);
  if ('response' in admission) return admission.response;
  const { admitted } = admission;

  // ADR 0012 step 4: a guarded replay dispatch must resolve through the
  // runtime tree path so the post-resolution identity guard runs — the
  // direct-iOS fast path has no daemon-tree node to check against.
  const directSelector = params.req.internal?.replayTargetGuard
    ? null
    : readDirectIosSelectorTapTarget({
        session: admitted.session,
        commandLabel: admitted.commandLabel,
        target: admitted.target,
        flags: params.req.flags,
      });
  if (directSelector) {
    const directResponse = await dispatchDirectIosSelectorTap(
      params,
      admitted.session,
      directSelector,
    );
    if (directResponse) return directResponse;
  }

  return await dispatchRuntimeInteraction(
    params,
    buildTargetedRuntimeOptions(params, command, admitted),
  );
}

type ParsedTargetedTouch = Extract<ParsedTouchTarget | ParsedLongPressTarget, { ok: true }>;

async function admitTargetedTouch(
  params: TargetedTouchParams,
  command: TargetedTouchCommand,
): Promise<{ response: DaemonResponse } | { admitted: AdmittedTargetedTouch }> {
  const { req, sessionStore, sessionName } = params;
  const session = sessionStore.get(sessionName);
  if (!session) return { response: noActiveSessionError() };

  const commandLabel = command === 'click' ? 'click' : command;
  const policyResponse = targetedTouchPolicyResponse(session, command, commandLabel, req.flags);
  if (policyResponse) return { response: policyResponse };

  const positionals = req.positionals ?? [];
  const parsedTarget =
    command === 'longpress'
      ? parseLongPressTarget(positionals)
      : parseTouchTarget(positionals, commandLabel);
  if (!parsedTarget.ok) return { response: parsedTarget.response };
  const staleRefsWarning = readTargetedTouchStalenessWarning(session, req, parsedTarget);
  const refAdmission = await admitTargetedTouchRef(
    params,
    session,
    command,
    parsedTarget,
    staleRefsWarning,
  );
  if (refAdmission.response) return { response: refAdmission.response };

  const clickButton = resolveClickButton(req.flags);
  return {
    admitted: {
      session,
      commandLabel,
      clickButton,
      resultButtonTag: buttonTag(clickButton),
      target: parsedTarget.target,
      durationMs: command === 'longpress' ? parsedTarget.durationMs : undefined,
      staleRefsWarning,
      androidFreshnessBaseline: refAdmission.androidFreshnessBaseline,
      refContext: readRefAdmissionContext(req, parsedTarget, staleRefsWarning),
    },
  };
}

/** Surface, capability, settle, and click-button policy, in that order. */
function targetedTouchPolicyResponse(
  session: SessionState,
  command: TargetedTouchCommand,
  commandLabel: TargetedTouchCommandLabel,
  flags: CommandFlags | undefined,
): DaemonResponse | undefined {
  const capabilityCommand = command === 'longpress' ? 'longpress' : 'press';
  const unsupportedSurfaceResponse = unsupportedMacOsDesktopSurfaceInteraction(
    session,
    commandLabel,
  );
  if (unsupportedSurfaceResponse) return unsupportedSurfaceResponse;
  const unsupported = requireCommandSupported(capabilityCommand, session.device);
  if (unsupported) return unsupported;
  const invalidSettleFlags = settleFlagGuardResponse(command, flags);
  if (invalidSettleFlags) return invalidSettleFlags;
  return clickButtonValidationResponse(session, command, commandLabel, flags);
}

function clickButtonValidationResponse(
  session: SessionState,
  command: TargetedTouchCommand,
  commandLabel: TargetedTouchCommandLabel,
  flags: CommandFlags | undefined,
): DaemonResponse | undefined {
  const clickButton = resolveClickButton(flags);
  if (command === 'longpress' || clickButton === 'primary') return undefined;
  const validationError = getClickButtonValidationError({
    commandLabel,
    platform: publicPlatformString(session.device),
    button: clickButton,
    count: flags?.count,
    intervalMs: flags?.intervalMs,
    holdMs: flags?.holdMs,
    jitterPx: flags?.jitterPx,
    doubleTap: flags?.doubleTap,
  });
  if (!validationError) return undefined;
  return errorResponse(validationError.code, validationError.message, validationError.details);
}

/**
 * Staleness relative to what the client knew when it sent this @ref — read
 * BEFORE any internal recapture (Android freshness refresh, --verify) advances
 * the generation as a side effect of this same command. Pinned refs
 * (`@e12~s3`) get a precise generation-mismatch warning; a plain ref warns
 * while the frame is expired. A mutating `find`'s internal dispatch supplies a
 * locator-minted ref (`internal.findResolvedTarget`), so it carries no
 * user-facing staleness — the caller never consumed a `@ref` (ADR 0014).
 */
function readTargetedTouchStalenessWarning(
  session: SessionState,
  req: InteractionHandlerParams['req'],
  parsedTarget: ParsedTargetedTouch,
): string | undefined {
  if (parsedTarget.target.kind !== 'ref') return undefined;
  if (req.internal?.findResolvedTarget !== undefined) return undefined;
  return resolveRefStalenessWarning({
    session,
    ref: parsedTarget.target.ref,
    mintedGeneration: parsedTarget.refGeneration,
  });
}

function readRefAdmissionContext(
  req: InteractionHandlerParams['req'],
  parsedTarget: ParsedTargetedTouch,
  staleRefsWarning: string | undefined,
): RefAdmissionContext | undefined {
  if (parsedTarget.target.kind !== 'ref') return undefined;
  if (req.internal?.findResolvedTarget !== undefined) return undefined;
  return {
    ref: parsedTarget.target.ref,
    mintedGeneration: parsedTarget.refGeneration,
    staleRefsWarning,
  };
}

async function admitTargetedTouchRef(
  params: TargetedTouchParams,
  session: SessionState,
  command: TargetedTouchCommand,
  parsedTarget: ParsedTargetedTouch,
  staleRefsWarning: string | undefined,
): Promise<{ response?: DaemonResponse; androidFreshnessBaseline?: SessionState['snapshot'] }> {
  const { req } = params;
  if (parsedTarget.target.kind !== 'ref') return {};
  const invalidRefFlagsResponse = params.refSnapshotFlagGuardResponse(
    command === 'longpress' ? 'longpress' : 'press',
    req.flags,
  );
  if (invalidRefFlagsResponse) return { response: invalidRefFlagsResponse };
  const admissionResponse = req.internal?.findResolvedTarget
    ? null
    : refMutationAdmissionResponse({
        session,
        ref: parsedTarget.target.ref,
        mintedGeneration: parsedTarget.refGeneration,
        staleRefsWarning,
      });
  if (admissionResponse) return { response: admissionResponse };
  return {
    androidFreshnessBaseline: await refreshAndroidRefSnapshotIfFreshnessActive(params, session),
  };
}

function buildTargetedRuntimeOptions(
  params: TargetedTouchParams,
  command: TargetedTouchCommand,
  admitted: AdmittedTargetedTouch,
): Parameters<typeof dispatchRuntimeInteraction<TargetedTouchResult>>[1] {
  const { req, sessionName } = params;
  const { session, target, durationMs, staleRefsWarning, resultButtonTag } = admitted;
  const targetedExtra =
    command === 'longpress'
      ? { ...(durationMs !== undefined ? { durationMs } : {}), gesture: 'longpress' }
      : resultButtonTag;
  return {
    androidFreshnessBaseline: admitted.androidFreshnessBaseline,
    refContext: admitted.refContext,
    iosTapCorroboration: { target, extra: targetedExtra },
    run: async (runtime) =>
      await runTargetedTouchInteraction({
        runtime,
        command,
        target,
        sessionName,
        requestId: req.meta?.requestId,
        clickButton: admitted.clickButton,
        flags: req.flags,
        durationMs,
        expectedResolvedTarget: req.internal?.replayTargetGuard,
        preresolvedTarget: req.internal?.findResolvedTarget,
      }),
    afterRun: async (result) => {
      if (session.lease?.leaseProvider) return undefined;
      return await assertAndroidPressStayedInApp(session, formatTouchTargetLabel(target, result));
    },
    buildPayloads: async (result) => {
      const resultDurationMs = readLongPressResultDuration(result);
      return await buildTargetedTouchResponsePayloads({
        params,
        session,
        result,
        staleRefsWarning,
        publicData: transformTouchResponseData({
          session,
          command: command === 'longpress' ? undefined : command,
          flags: req.flags,
          data: result.backendResult,
        }),
        extra:
          command === 'longpress'
            ? {
                ...(resultDurationMs !== undefined ? { durationMs: resultDurationMs } : {}),
                gesture: 'longpress',
              }
            : resultButtonTag,
      });
    },
  };
}

async function runTargetedTouchInteraction(params: {
  runtime: ReturnType<typeof createInteractionRuntime>;
  command: TargetedTouchCommand;
  target: InteractionTarget;
  sessionName: string;
  requestId: string | undefined;
  clickButton: ReturnType<typeof resolveClickButton>;
  flags: CommandFlags | undefined;
  durationMs?: number;
  expectedResolvedTarget?: ReplayTargetGuardDenotation;
  /** #1654: a mutating `find`'s already-resolved node; see daemon/types.ts. */
  preresolvedTarget?: PreresolvedInteractionTarget;
}): Promise<TargetedTouchResult> {
  const { runtime, command, target, sessionName, requestId, flags, expectedResolvedTarget } =
    params;
  const settle = readSettleRequest(flags);
  if (command === 'longpress') {
    return await runtime.interactions.longPress(target, {
      session: sessionName,
      requestId,
      durationMs: params.durationMs,
      settle,
      expectedResolvedTarget,
    });
  }

  const options = {
    session: sessionName,
    requestId,
    button: params.clickButton,
    count: flags?.count,
    intervalMs: flags?.intervalMs,
    holdMs: flags?.holdMs,
    jitterPx: flags?.jitterPx,
    doubleTap: flags?.doubleTap,
    verify: flags?.verify,
    settle,
    expectedResolvedTarget,
    // Only click/press take it: `find` dispatches click and fill, never
    // longpress, so declaring it on the longPress options above would be an
    // unconsumed claim (#1649 review).
    preresolvedTarget: params.preresolvedTarget,
  };
  return command === 'click'
    ? await runtime.interactions.click(target, options)
    : await runtime.interactions.press(target, options);
}

function readLongPressResultDuration(result: TargetedTouchResult): number | undefined {
  return 'durationMs' in result ? result.durationMs : undefined;
}
