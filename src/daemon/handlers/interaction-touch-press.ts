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
import { refreshAndroidRefSnapshotIfFreshnessActive } from './interaction-touch-android-readiness.ts';
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
} from './interaction-touch-targets.ts';
import { errorResponse, noActiveSessionError, requireCommandSupported } from './response.ts';

/**
 * How a targeted `press`/`click`/`longpress` is admitted and executed: surface
 * and capability policy, click-option validation, `@ref` admission and
 * staleness, the direct-iOS attempt, and the runtime dispatch it delegates to.
 */

export type TargetedTouchCommand = 'press' | 'click' | 'longpress';

export async function dispatchTargetedTouchViaRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
  },
  command: TargetedTouchCommand,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (!session) return noActiveSessionError();

  const commandLabel = command === 'click' ? 'click' : command;
  const capabilityCommand = command === 'longpress' ? 'longpress' : 'press';
  const unsupportedSurfaceResponse = unsupportedMacOsDesktopSurfaceInteraction(
    session,
    commandLabel,
  );
  if (unsupportedSurfaceResponse) return unsupportedSurfaceResponse;
  const unsupported = requireCommandSupported(capabilityCommand, session.device);
  if (unsupported) return unsupported;
  const invalidSettleFlags = settleFlagGuardResponse(command, req.flags);
  if (invalidSettleFlags) return invalidSettleFlags;

  const clickButton = resolveClickButton(req.flags);
  const resultButtonTag = buttonTag(clickButton);
  if (command !== 'longpress' && clickButton !== 'primary') {
    const validationError = getClickButtonValidationError({
      commandLabel,
      platform: publicPlatformString(session.device),
      button: clickButton,
      count: req.flags?.count,
      intervalMs: req.flags?.intervalMs,
      holdMs: req.flags?.holdMs,
      jitterPx: req.flags?.jitterPx,
      doubleTap: req.flags?.doubleTap,
    });
    if (validationError) {
      return errorResponse(validationError.code, validationError.message, validationError.details);
    }
  }

  const parsedTarget =
    command === 'longpress'
      ? parseLongPressTarget(req.positionals ?? [])
      : parseTouchTarget(req.positionals ?? [], commandLabel);
  if (!parsedTarget.ok) return parsedTarget.response;
  // Staleness relative to what the client knew when it sent this @ref — read
  // BEFORE any internal recapture (Android freshness refresh, --verify) advances
  // the generation as a side effect of this same command. Pinned refs
  // (`@e12~s3`) get a precise generation-mismatch warning; a plain ref warns
  // while the frame is expired. A mutating `find`'s internal dispatch supplies a
  // locator-minted ref (`internal.findResolvedTarget`), so it carries no
  // user-facing staleness — the caller never consumed a `@ref` (ADR 0014).
  const staleRefsWarning =
    parsedTarget.target.kind === 'ref' && req.internal?.findResolvedTarget === undefined
      ? resolveRefStalenessWarning({
          session,
          ref: parsedTarget.target.ref,
          mintedGeneration: parsedTarget.refGeneration,
        })
      : undefined;
  let androidFreshnessBaseline: SessionState['snapshot'];
  if (parsedTarget.target.kind === 'ref') {
    const invalidRefFlagsResponse = params.refSnapshotFlagGuardResponse(
      command === 'longpress' ? 'longpress' : 'press',
      req.flags,
    );
    if (invalidRefFlagsResponse) return invalidRefFlagsResponse;
    const admissionResponse = req.internal?.findResolvedTarget
      ? null
      : refMutationAdmissionResponse({
          session,
          ref: parsedTarget.target.ref,
          mintedGeneration: parsedTarget.refGeneration,
          staleRefsWarning,
        });
    if (admissionResponse) return admissionResponse;
    androidFreshnessBaseline = await refreshAndroidRefSnapshotIfFreshnessActive(params, session);
  }
  // ADR 0012 step 4: a guarded replay dispatch must resolve through the
  // runtime tree path so the post-resolution identity guard runs — the
  // direct-iOS fast path has no daemon-tree node to check against.
  const replayTargetGuard = req.internal?.replayTargetGuard;
  const directSelector = replayTargetGuard
    ? null
    : readDirectIosSelectorTapTarget({
        session,
        commandLabel,
        target: parsedTarget.target,
        flags: req.flags,
      });
  if (directSelector) {
    const directResponse = await dispatchDirectIosSelectorTap(params, session, directSelector);
    if (directResponse) return directResponse;
  }
  const durationMs = command === 'longpress' ? parsedTarget.durationMs : undefined;

  return await dispatchRuntimeInteraction(params, {
    androidFreshnessBaseline,
    refContext:
      parsedTarget.target.kind === 'ref' && req.internal?.findResolvedTarget === undefined
        ? {
            ref: parsedTarget.target.ref,
            mintedGeneration: parsedTarget.refGeneration,
            staleRefsWarning,
          }
        : undefined,
    iosTapCorroboration: {
      target: parsedTarget.target,
      extra:
        command === 'longpress'
          ? {
              ...(durationMs !== undefined ? { durationMs } : {}),
              gesture: 'longpress',
            }
          : resultButtonTag,
    },
    run: async (runtime) =>
      await runTargetedTouchInteraction({
        runtime,
        command,
        target: parsedTarget.target,
        sessionName,
        requestId: req.meta?.requestId,
        clickButton,
        flags: req.flags,
        durationMs,
        expectedResolvedTarget: replayTargetGuard,
        preresolvedTarget: req.internal?.findResolvedTarget,
      }),
    afterRun: async (result) => {
      if (session.lease?.leaseProvider) return undefined;
      return await assertAndroidPressStayedInApp(
        session,
        formatTouchTargetLabel(parsedTarget.target, result),
      );
    },
    buildPayloads: async (result) => {
      const durationMs = readLongPressResultDuration(result);
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
                ...(durationMs !== undefined ? { durationMs } : {}),
                gesture: 'longpress',
              }
            : resultButtonTag,
      });
    },
  });
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
