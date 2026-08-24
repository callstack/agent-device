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
import { refreshAndroidRefSnapshotIfFreshnessActive } from './interaction-touch-android-freshness.ts';
import { prepareTouchDispatch } from './interaction-touch-prepare.ts';

/**
 * How an admitted targeted `press`/`click`/`longpress`/`hover` executes: the direct-iOS
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
  const prepared = await prepareTouchDispatch(
    params,
    admitted.session,
    command,
    admitted.target.kind !== 'point',
  );
  if (!prepared.ok) return prepared.response;
  const { touchExecutor } = prepared;
  const androidFreshnessBaseline =
    admitted.target.kind === 'ref'
      ? await refreshAndroidRefSnapshotIfFreshnessActive(params, admitted.session)
      : undefined;
  const boundAdmitted = {
    ...admitted,
    androidFreshnessBaseline,
  };

  // ADR 0012 step 4: a guarded replay dispatch must resolve through the
  // runtime tree path so the post-resolution identity guard runs — the
  // direct-iOS fast path has no daemon-tree node to check against.
  const directSelector = params.req.internal?.replayTargetGuard
    ? null
    : readDirectIosSelectorTapTarget({
        session: boundAdmitted.session,
        commandLabel: boundAdmitted.commandLabel,
        target: boundAdmitted.target,
        flags: params.req.flags,
        tapElementSelectorAvailable: touchExecutor.tapElementSelector !== undefined,
      });
  if (directSelector && touchExecutor.tapElementSelector) {
    const directResponse = await dispatchDirectIosSelectorTap(
      params,
      boundAdmitted.session,
      directSelector,
      touchExecutor.tapElementSelector,
    );
    if (directResponse) return directResponse;
  }

  return await dispatchRuntimeInteraction(params, {
    ...buildTargetedRuntimeOptions(params, command, boundAdmitted),
    touchExecutor,
  });
}

function buildTargetedRuntimeOptions(
  params: TargetedTouchParams,
  command: TargetedTouchCommand,
  admitted: AdmittedTargetedTouch & {
    androidFreshnessBaseline: AdmittedTargetedTouch['session']['snapshot'];
  },
): Omit<Parameters<typeof dispatchRuntimeInteraction<TargetedTouchResult>>[1], 'touchExecutor'> {
  const { req, sessionName } = params;
  const { session, target, durationMs, staleRefsWarning, resultButtonTag } = admitted;
  const targetedExtra =
    command === 'longpress'
      ? { ...(durationMs !== undefined ? { durationMs } : {}), gesture: 'longpress' }
      : command === 'hover'
        ? { gesture: 'hover' }
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
          command: command === 'longpress' || command === 'hover' ? undefined : command,
          flags: req.flags,
          data: result.backendResult,
        }),
        extra:
          command === 'longpress'
            ? {
                ...(resultDurationMs !== undefined ? { durationMs: resultDurationMs } : {}),
                gesture: 'longpress',
              }
            : command === 'hover'
              ? { gesture: 'hover' }
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
  const shared = {
    session: sessionName,
    requestId,
    settle: readSettleRequest(flags),
    expectedResolvedTarget,
  };
  switch (command) {
    case 'longpress':
      return await runtime.interactions.longPress(target, {
        ...shared,
        durationMs: params.durationMs,
      });
    case 'hover':
      return await runtime.interactions.hover(target, shared);
    case 'click':
      return await runtime.interactions.click(target, pressRuntimeOptions(params, shared));
    case 'press':
      return await runtime.interactions.press(target, pressRuntimeOptions(params, shared));
  }
}

function pressRuntimeOptions(
  params: {
    clickButton: ReturnType<typeof resolveClickButton>;
    flags: CommandFlags | undefined;
    preresolvedTarget?: PreresolvedInteractionTarget;
  },
  shared: {
    session: string;
    requestId: string | undefined;
    settle: ReturnType<typeof readSettleRequest>;
    expectedResolvedTarget?: ReplayTargetGuardDenotation;
  },
) {
  const { flags } = params;
  return {
    ...shared,
    button: params.clickButton,
    count: flags?.count,
    intervalMs: flags?.intervalMs,
    holdMs: flags?.holdMs,
    jitterPx: flags?.jitterPx,
    doubleTap: flags?.doubleTap,
    verify: flags?.verify,
    // Only click/press take it: `find` dispatches click and fill, never
    // longpress or hover, so declaring it on their options would be an
    // unconsumed claim (#1649 review).
    preresolvedTarget: params.preresolvedTarget,
  };
}

function readLongPressResultDuration(result: TargetedTouchResult): number | undefined {
  return 'durationMs' in result ? result.durationMs : undefined;
}
