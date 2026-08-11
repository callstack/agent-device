import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  InteractionTarget,
  PreresolvedInteractionTarget,
  resolveClickButton,
} from '@agent-device/contracts/interaction';
import type { ReplayTargetGuardDenotation } from '@agent-device/contracts/replay';
import type { DaemonResponse } from '../types.ts';
import { assertAndroidPressStayedInApp } from './interaction-android-escape.ts';
import { readSettleRequest } from './interaction-flags.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import { dispatchDirectIosSelectorTap } from './interaction-touch-direct-ios.ts';
import { readDirectIosSelectorTapTarget } from './interaction-touch-direct-ios-eligibility.ts';
import {
  admitTargetedTouch,
  type AdmittedTargetedTouch,
  type TargetedTouchCommand,
  type TargetedTouchParams,
} from './interaction-touch-press-admission.ts';
import {
  buildTargetedTouchResponsePayloads,
  transformTouchResponseData,
  type TargetedTouchResult,
} from './interaction-touch-response.ts';
import { dispatchRuntimeInteraction } from './interaction-touch-runtime.ts';
import { formatTouchTargetLabel } from './interaction-touch-targets.ts';

/**
 * How an admitted targeted `press`/`click`/`longpress` executes: the direct-iOS
 * attempt, then the shared runtime dispatch it delegates to with the options
 * and payload projection this command family owns.
 */

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
