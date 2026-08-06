import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  FillCommandResult,
  GestureReferenceFrame,
  InteractionTarget,
  LongPressCommandResult,
  PressCommandResult,
  ResolvedInteractionTarget,
} from '@agent-device/contracts/interaction';
import {
  buttonTag,
  getClickButtonValidationError,
  resolveClickButton,
} from '@agent-device/contracts/interaction';
import { isApplePlatform, publicPlatformString } from '@agent-device/kernel/device';
import { asAppError, normalizeError } from '@agent-device/kernel/errors';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../../core/command-descriptor/registry.ts';
import { dispatchCommand } from '../../core/dispatch.ts';
import {
  transformInteractionResponseData,
  type InteractionResponseDataTransformCommand,
} from '../../core/interaction-response-data-transform.ts';
import { normalizeAppleRunnerResultForResponse } from '../../platforms/apple/core/runner/runner-result-response-normalization.ts';
import type { ReplayTargetGuardDenotation } from '@agent-device/contracts/replay';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { getActiveAndroidSnapshotFreshness } from '../android-snapshot-freshness.ts';
import { readResolvedInteractionTarget } from '../../contracts/interaction-outcome.ts';
import {
  ensureAndroidBlockingSystemDialogReady,
  type AndroidBlockingDialogReadinessResult,
} from '../android-system-dialog.ts';
import {
  isDirectIosSelectorFallbackError,
  readSimpleIosSelectorTarget,
  type DirectIosSelectorTarget,
} from '../direct-ios-selector.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { issueSettleRefs, resolveRefStalenessWarning } from '../session-snapshot.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import {
  assertAndroidPressStayedInApp,
  isAndroidEscapeError,
} from './interaction-android-escape.ts';
import { finalizeTouchInteraction, type InteractionHandlerParams } from './interaction-common.ts';
import {
  readSettleRequest,
  settleFlagGuardResponse,
  type RefSnapshotFlagGuardResponse,
} from './interaction-flags.ts';
import { assertRecordedFillParameterization } from './interaction-recorded-input.ts';
import { refMutationAdmissionResponse } from './interaction-ref-policy.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import { unsupportedMacOsDesktopSurfaceInteraction } from './interaction-touch-policy.ts';
import {
  readSnapshotNodesReferenceFrame,
  resolveDirectTouchReferenceFrameSafely,
} from './interaction-touch-reference-frame.ts';
import {
  buildInteractionResponseData,
  buildCorroboratedTapResponseData,
  type InteractionResponsePayloads,
} from './interaction-touch-response.ts';
import {
  formatTouchTargetLabel,
  parseFillTarget,
  parseLongPressTarget,
  parseTouchTarget,
} from './interaction-touch-targets.ts';
import { corroborateIosTapFailure, interactionTargetExtra } from './interaction-ios-tap-outcome.ts';
import { errorResponse, noActiveSessionError, requireCommandSupported } from './response.ts';

export async function handleTouchInteractionCommands(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
  },
): Promise<DaemonResponse | null> {
  switch (params.req.command) {
    case 'press':
      return await dispatchTargetedTouchViaRuntime(params, 'press');
    case 'click':
      return await dispatchTargetedTouchViaRuntime(params, 'click');
    case 'longpress':
      return await dispatchTargetedTouchViaRuntime(params, 'longpress');
    case 'fill':
      return await dispatchFillViaRuntime(params);
    default:
      return null;
  }
}

// fallow-ignore-next-line complexity
async function dispatchTargetedTouchViaRuntime(
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
    parsedTarget.target.kind === 'ref' && req.internal?.findResolvedTarget !== true
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
      parsedTarget.target.kind === 'ref' && req.internal?.findResolvedTarget !== true
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

type TargetedTouchCommand = 'press' | 'click' | 'longpress';
type TargetedTouchResult = PressCommandResult | LongPressCommandResult;

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
  };
  return command === 'click'
    ? await runtime.interactions.click(target, options)
    : await runtime.interactions.press(target, options);
}

async function buildTargetedTouchResponsePayloads(params: {
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  };
  session: SessionState;
  result: TargetedTouchResult;
  staleRefsWarning: string | undefined;
  publicData?: Record<string, unknown>;
  extra: Record<string, unknown>;
}): Promise<InteractionResponsePayloads> {
  const { params: handlerParams, session, result, publicData, extra } = params;
  const referenceFrame =
    result.kind === 'point'
      ? await resolveDirectTouchReferenceFrameSafely({
          session,
          flags: handlerParams.req.flags,
          sessionStore: handlerParams.sessionStore,
          contextFromFlags: handlerParams.contextFromFlags,
          captureSnapshotForSession: handlerParams.captureSnapshotForSession,
        })
      : readSnapshotNodesReferenceFrame(session.snapshot?.nodes ?? []);
  return buildInteractionResponseData({
    source: { kind: 'runtime', result, publicData },
    referenceFrame,
    extra,
    staleRefsWarning: params.staleRefsWarning,
    settleRefsGeneration: issueSettleRefs(session, result.settle),
  });
}

function readLongPressResultDuration(result: TargetedTouchResult): number | undefined {
  return 'durationMs' in result ? result.durationMs : undefined;
}

function readDirectIosSelectorTapTarget(params: {
  session: SessionState;
  commandLabel: string;
  target: InteractionTarget;
  flags: CommandFlags | undefined;
}): DirectIosSelectorTarget | null {
  const { session, commandLabel, target, flags } = params;
  if (commandLabel !== 'click') return null;
  if (target.kind !== 'selector') return null;
  if (session.recordSession) return null;
  if (hasNonDefaultClickOptions(flags)) return null;
  if (commandSupportsVerifyEvidence(commandLabel) && flags?.verify === true) return null;
  if (commandSupportsSettleObservation(commandLabel) && flags?.settle === true) return null;
  return readDirectSelectorWithMaestroFallback(session, target.selector, flags);
}

function readDirectSelectorWithMaestroFallback(
  session: SessionState,
  selectorExpression: string,
  flags: CommandFlags | undefined,
): DirectIosSelectorTarget | null {
  const selector = readSimpleIosSelectorTarget({ session, selectorExpression });
  if (!selector) return null;
  return {
    ...selector,
    ...(flags?.maestro?.allowNonHittableCoordinateFallback
      ? { allowNonHittableCoordinateFallback: true }
      : {}),
    ...(flags?.maestro?.expectedTapPoint ? { expectedPoint: flags.maestro.expectedTapPoint } : {}),
  };
}

function hasNonDefaultClickOptions(flags: CommandFlags | undefined): boolean {
  return Boolean(
    flags?.count !== undefined ||
    flags?.intervalMs !== undefined ||
    flags?.holdMs !== undefined ||
    flags?.jitterPx !== undefined ||
    flags?.doubleTap !== undefined ||
    (flags?.clickButton !== undefined && flags.clickButton !== 'primary'),
  );
}

async function dispatchDirectIosSelectorTap(
  params: InteractionHandlerParams & { captureSnapshotForSession: CaptureSnapshotForSession },
  session: SessionState,
  selector: DirectIosSelectorTarget,
): Promise<DaemonResponse | null> {
  return await dispatchDirectIosSelectorInteraction({
    params,
    session,
    selector,
    command: 'press',
    positionals: [],
    extra: { selector: selector.raw },
    fallbackPhase: 'ios_direct_selector_tap_fallback',
  });
}

async function dispatchDirectIosSelectorInteraction(params: {
  params: InteractionHandlerParams & { captureSnapshotForSession: CaptureSnapshotForSession };
  session: SessionState;
  selector: DirectIosSelectorTarget;
  command: 'press' | 'fill';
  positionals: string[];
  extra: Record<string, unknown>;
  fallbackPhase: string;
}): Promise<DaemonResponse | null> {
  const {
    params: handlerParams,
    session,
    selector,
    command,
    positionals,
    extra,
    fallbackPhase,
  } = params;
  const actionStartedAt = Date.now();
  // ADR 0014 side-effect seam: the direct iOS selector path fuses its final
  // status/target check and mutation into one runner request and consumes no
  // ref, so dispatching that fused request is the conservative seam. A later
  // not-found/timeout is post-seam and does not restore the frame.
  expireRefFrame(session);
  try {
    const data =
      (await dispatchCommand(session.device, command, positionals, handlerParams.req.flags?.out, {
        ...handlerParams.contextFromFlags(
          handlerParams.req.flags,
          session.appBundleId,
          session.trace?.outPath,
        ),
        directElementSelector: selector,
        surface: session.surface,
      })) ?? {};
    const actionFinishedAt = Date.now();
    const point = readPointFromDirectSelectorTapResult(data);
    const publicData = transformTouchResponseData({
      session,
      command: readInteractionResponseDataTransformCommand(handlerParams.req.command, command),
      flags: handlerParams.req.flags,
      data,
    });
    const maestroFallback = maestroFallbackDisclosure(
      selector.allowNonHittableCoordinateFallback === true,
      data,
    );
    const { result, responseData } = buildInteractionResponseData({
      source: {
        kind: 'runner-payload',
        targetKind: 'selector',
        data,
        publicData,
        point,
        maestroCoordinateFallbackDispatched: maestroFallback.used,
      },
      referenceFrame: readReferenceFrameFromDirectSelectorTapResult(data),
      extra: {
        ...extra,
        ...maestroFallback.extra,
      },
    });
    return finalizeTouchInteraction({
      session,
      sessionStore: handlerParams.sessionStore,
      command: handlerParams.req.command,
      positionals: handlerParams.req.positionals ?? [],
      retryPositionals: pointPositionals(point),
      flags: handlerParams.req.flags,
      result,
      responseData,
      actionStartedAt,
      actionFinishedAt,
    });
  } catch (error) {
    const corroboratedResponse = await buildDirectIosCorroboratedResponse({
      error,
      handlerParams,
      session,
      extra,
      positionals,
      actionStartedAt,
    });
    if (corroboratedResponse) return corroboratedResponse;
    // ADR 0011 delegation-on-error: semantic runner failures fall back to the
    // tree-based runtime path — except for Maestro replay dispatches, whose
    // runner-native error shapes must be preserved.
    const fallback = isDirectIosSelectorFallbackError(error, {
      delegateSemanticFailures: selector.allowNonHittableCoordinateFallback !== true,
    });
    if (!fallback) {
      return { ok: false, error: normalizeError(error) };
    }
    emitDiagnostic({
      level: 'debug',
      phase: fallbackPhase,
      data: {
        selector: selector.raw,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return null;
  }
}

async function buildDirectIosCorroboratedResponse(params: {
  error: unknown;
  handlerParams: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  };
  session: SessionState;
  extra: Record<string, unknown>;
  positionals: string[];
  actionStartedAt: number;
}): Promise<DaemonResponse | undefined> {
  const { error, handlerParams, session, extra, positionals, actionStartedAt } = params;
  const corroboration = await corroborateIosTapFailure({
    error,
    command: handlerParams.req.command,
    requestId: handlerParams.req.meta?.requestId,
    flags: handlerParams.req.flags,
    session,
    sessionStore: handlerParams.sessionStore,
    contextFromFlags: handlerParams.contextFromFlags,
    captureSnapshotForSession: handlerParams.captureSnapshotForSession,
  });
  if (!corroboration) return undefined;

  const { result, responseData } = buildCorroboratedTapResponseData({
    targetKind: 'selector',
    warning: corroboration.warning,
    resolution: { source: 'direct-ios', kind: 'not-observed' },
    extra,
  });
  return finalizeTouchInteraction({
    session,
    sessionStore: handlerParams.sessionStore,
    command: handlerParams.req.command,
    positionals: handlerParams.req.positionals ?? positionals,
    flags: handlerParams.req.flags,
    result,
    responseData,
    scheduleInteractionOutcomeRetry: false,
    actionStartedAt,
    actionFinishedAt: Date.now(),
  });
}

function transformTouchResponseData(params: {
  session: SessionState;
  command?: InteractionResponseDataTransformCommand;
  flags: CommandFlags | undefined;
  data: Record<string, unknown> | undefined;
}): Record<string, unknown> | undefined {
  const base = isApplePlatform(params.session.device.platform)
    ? normalizeAppleRunnerResultForResponse(params.data)
    : params.data;
  if (!params.command) return base;
  return transformInteractionResponseData({
    command: params.command,
    input: params.flags as Record<string, unknown> | undefined,
    data: base,
  });
}

function readInteractionResponseDataTransformCommand(
  requestCommand: string,
  dispatchCommand: 'press' | 'fill',
): InteractionResponseDataTransformCommand {
  if (requestCommand === 'click' || requestCommand === 'press' || requestCommand === 'fill') {
    return requestCommand;
  }
  return dispatchCommand;
}

/** The response fields disclosing the Maestro coordinate fallback's policy and outcome. */
type MaestroFallbackResponseFields = {
  maestroNonHittableCoordinateFallbackAllowed?: true;
  maestroNonHittableCoordinateFallbackUsed?: boolean;
  maestroFallbackReason?: 'non-hittable-coordinate';
};

type MaestroFallbackDisclosure = {
  /**
   * The runner EXECUTED the coordinate fallback. Separate from the response
   * fields because it also selects the dispatch path the response builder
   * discloses a resolution for (interaction-touch-response.ts).
   */
  used: boolean;
  extra: MaestroFallbackResponseFields;
};

function maestroFallbackDisclosure(
  allowed: boolean,
  data: Record<string, unknown> | undefined,
): MaestroFallbackDisclosure {
  if (!allowed) return { used: false, extra: {} };
  const used = data?.maestroNonHittableCoordinateFallbackUsed === true;
  return {
    used,
    extra: {
      maestroNonHittableCoordinateFallbackAllowed: true,
      maestroNonHittableCoordinateFallbackUsed: used,
      ...(used ? { maestroFallbackReason: 'non-hittable-coordinate' as const } : {}),
    },
  };
}

function readPointFromDirectSelectorTapResult(data: Record<string, unknown>): {
  x: number;
  y: number;
} {
  const x = typeof data.x === 'number' ? data.x : undefined;
  const y = typeof data.y === 'number' ? data.y : undefined;
  if (x !== undefined && y !== undefined) {
    return { x, y };
  }
  return { x: 0, y: 0 };
}

function readReferenceFrameFromDirectSelectorTapResult(
  data: Record<string, unknown>,
): GestureReferenceFrame | undefined {
  return typeof data.referenceWidth === 'number' && typeof data.referenceHeight === 'number'
    ? { referenceWidth: data.referenceWidth, referenceHeight: data.referenceHeight }
    : undefined;
}

async function dispatchFillViaRuntime(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
  },
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const session = sessionStore.get(sessionName);
  if (session) {
    const unsupportedSurfaceResponse = unsupportedMacOsDesktopSurfaceInteraction(session, 'fill');
    if (unsupportedSurfaceResponse) return unsupportedSurfaceResponse;
    const unsupported = requireCommandSupported('fill', session.device);
    if (unsupported) return unsupported;
  }
  if (!session) return noActiveSessionError();
  assertRecordedFillParameterization({
    session,
    flags: req.flags,
    replayPlanStep: req.internal?.replayPlanStep === true,
  });
  const invalidSettleFlags = settleFlagGuardResponse('fill', req.flags);
  if (invalidSettleFlags) return invalidSettleFlags;

  const parsedTarget = parseFillTarget(req.positionals ?? []);
  if (!parsedTarget.ok) return parsedTarget.response;
  const refPreamble = await prepareFillRefTarget(
    params,
    session,
    parsedTarget.target,
    parsedTarget.refGeneration,
  );
  if (refPreamble.response) return refPreamble.response;
  const { staleRefsWarning } = refPreamble;
  const replayTargetGuard = req.internal?.replayTargetGuard;

  return await dispatchRuntimeInteraction(params, {
    refContext:
      parsedTarget.target.kind === 'ref' && req.internal?.findResolvedTarget !== true
        ? {
            ref: parsedTarget.target.ref,
            mintedGeneration: parsedTarget.refGeneration,
            staleRefsWarning,
          }
        : undefined,
    run: async (runtime) =>
      await runtime.interactions.fill(parsedTarget.target, parsedTarget.text, {
        session: sessionName,
        requestId: req.meta?.requestId,
        delayMs: req.flags?.delayMs,
        allowNonHittableCoordinateFallback: req.flags?.maestro?.allowNonHittableCoordinateFallback,
        verify: req.flags?.verify,
        settle: readSettleRequest(req.flags),
        expectedResolvedTarget: replayTargetGuard,
      }),
    buildPayloads: (result) =>
      buildFillResponsePayloads({
        session,
        result,
        text: parsedTarget.text,
        flags: req.flags,
        staleRefsWarning,
      }),
  });
}

// The fill @ref preamble shared with the press path's shape: read staleness
// relative to what the client knew BEFORE any internal recapture, validate
// @ref-incompatible flags, enforce iOS mutation freshness, and run the Android
// freshness refresh.
async function prepareFillRefTarget(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
    refSnapshotFlagGuardResponse: RefSnapshotFlagGuardResponse;
  },
  session: SessionState,
  target: InteractionTarget,
  refGeneration: number | undefined,
): Promise<{ response?: DaemonResponse; staleRefsWarning?: string }> {
  if (target.kind !== 'ref') return {};
  // A mutating `find`'s internal dispatch supplies a locator-minted ref, so the
  // public response must not claim the caller consumed a stale `@ref` (ADR 0014).
  const staleRefsWarning =
    params.req.internal?.findResolvedTarget === true
      ? undefined
      : resolveRefStalenessWarning({
          session,
          ref: target.ref,
          mintedGeneration: refGeneration,
        });
  const invalidRefFlagsResponse = params.refSnapshotFlagGuardResponse('fill', params.req.flags);
  if (invalidRefFlagsResponse) return { response: invalidRefFlagsResponse, staleRefsWarning };
  const admissionResponse = params.req.internal?.findResolvedTarget
    ? null
    : refMutationAdmissionResponse({
        session,
        ref: target.ref,
        mintedGeneration: refGeneration,
        staleRefsWarning,
      });
  if (admissionResponse) return { response: admissionResponse, staleRefsWarning };
  await refreshAndroidRefSnapshotIfFreshnessActive(params, session);
  return { staleRefsWarning };
}

function buildFillResponsePayloads(params: {
  session: SessionState;
  result: FillCommandResult;
  text: string;
  flags: CommandFlags | undefined;
  staleRefsWarning: string | undefined;
}): InteractionResponsePayloads {
  const { session, result } = params;
  const maestroFallback = maestroFallbackDisclosure(
    params.flags?.maestro?.allowNonHittableCoordinateFallback === true,
    result.backendResult,
  );
  const referenceFrame =
    result.kind === 'point'
      ? undefined
      : readSnapshotNodesReferenceFrame(session.snapshot?.nodes ?? []);
  return buildInteractionResponseData({
    source: {
      kind: 'runtime',
      result,
      publicData: transformTouchResponseData({
        session,
        command: 'fill',
        flags: params.flags,
        data: result.backendResult,
      }),
      maestroCoordinateFallbackDispatched: maestroFallback.used,
    },
    referenceFrame,
    extra: { text: params.text, ...maestroFallback.extra },
    staleRefsWarning: params.staleRefsWarning,
    settleRefsGeneration: issueSettleRefs(session, result.settle),
  });
}

async function dispatchRuntimeInteraction<
  TResult extends PressCommandResult | FillCommandResult | LongPressCommandResult,
>(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
  options: {
    androidFreshnessBaseline?: SessionState['snapshot'];
    /**
     * Present when the action targets a `@ref`: if Android dialog recovery
     * expires the frame before dispatch, the action aborts through the shared
     * admission rejection built from this context.
     */
    refContext?: RefAdmissionContext;
    /** A failed local iOS tap may be corroborated against one same-scope capture. */
    iosTapCorroboration?: {
      target: InteractionTarget;
      extra: Record<string, unknown>;
    };
    run(runtime: ReturnType<typeof createInteractionRuntime>): Promise<TResult>;
    /** May return a warning to append to the successful response (e.g. a pending Android permission dialog). */
    afterRun?(result: TResult): Promise<string | undefined>;
    buildPayloads(
      result: TResult,
    ): InteractionResponsePayloads | Promise<InteractionResponsePayloads>;
  },
): Promise<DaemonResponse> {
  const session = params.sessionStore.get(params.sessionName);
  if (!session) return noActiveSessionError();
  const runtime = createInteractionRuntime(params);
  const actionStartedAt = Date.now();
  try {
    let afterRunWarning: string | undefined;
    const outcome = await runWithAndroidDialogReadinessCheck(
      session,
      params.req.command,
      { refContext: options.refContext },
      async () => {
        const result = await options.run(runtime);
        afterRunWarning = await options.afterRun?.(result);
        return result;
      },
    );
    if (outcome.aborted) return outcome.response;
    const { readiness, runtimeResult } = outcome;
    const actionFinishedAt = Date.now();
    const { result, responseData, recordedTarget } = await options.buildPayloads(runtimeResult);
    // Append, don't clobber — the builder may already carry a warning
    // (e.g. stale-refs, #1076).
    const appendedWarnings = [
      ...(readiness.status === 'recovered' ? [readiness.warning] : []),
      ...(afterRunWarning ? [afterRunWarning] : []),
    ];
    if (appendedWarnings.length > 0) {
      const warning = [
        ...(typeof responseData.warning === 'string' ? [responseData.warning] : []),
        ...appendedWarnings,
      ].join(' ');
      result.warning = warning;
      responseData.warning = warning;
    }
    return finalizeTouchInteraction({
      session,
      sessionStore: params.sessionStore,
      command: params.req.command,
      positionals: params.req.positionals ?? [],
      retryPositionals: retryPositionalsForRuntimeResult(params.req.command, runtimeResult),
      flags: params.req.flags,
      result,
      responseData,
      recordedTarget,
      actionStartedAt,
      actionFinishedAt,
      androidFreshnessBaseline: options.androidFreshnessBaseline,
    });
  } catch (error) {
    const appError = asAppError(error);
    if (isAndroidEscapeError(appError)) throw appError;
    const corroboratedResponse = await buildRuntimeIosCorroboratedResponse({
      error,
      handlerParams: params,
      session,
      target: options.iosTapCorroboration?.target,
      extra: options.iosTapCorroboration?.extra,
      actionStartedAt,
      androidFreshnessBaseline: options.androidFreshnessBaseline,
    });
    if (corroboratedResponse) return corroboratedResponse;
    return appErrorResponse(error);
  }
}

async function buildRuntimeIosCorroboratedResponse(params: {
  error: unknown;
  handlerParams: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  };
  session: SessionState;
  target: InteractionTarget | undefined;
  extra: Record<string, unknown> | undefined;
  actionStartedAt: number;
  androidFreshnessBaseline: SessionState['snapshot'] | undefined;
}): Promise<DaemonResponse | undefined> {
  if (!params.target) return undefined;
  const resolvedTarget = readResolvedInteractionTarget(params.error);
  if (!resolvedTarget && params.session.recordSession) return undefined;
  const corroboration = await corroborateIosTapFailure({
    error: params.error,
    command: params.handlerParams.req.command,
    requestId: params.handlerParams.req.meta?.requestId,
    flags: params.handlerParams.req.flags,
    session: params.session,
    sessionStore: params.handlerParams.sessionStore,
    contextFromFlags: params.handlerParams.contextFromFlags,
    captureSnapshotForSession: params.handlerParams.captureSnapshotForSession,
  });
  if (!corroboration) return undefined;

  const payloads = buildIosCorroboratedPayloads({
    target: params.target,
    resolvedTarget,
    warning: corroboration.warning,
    referenceFrame: readSnapshotNodesReferenceFrame(params.session.snapshot?.nodes ?? []),
    extra: params.extra,
  });
  return finalizeTouchInteraction({
    session: params.session,
    sessionStore: params.handlerParams.sessionStore,
    command: params.handlerParams.req.command,
    positionals: params.handlerParams.req.positionals ?? [],
    flags: params.handlerParams.req.flags,
    result: payloads.result,
    responseData: payloads.responseData,
    recordedTarget: payloads.recordedTarget,
    scheduleInteractionOutcomeRetry: false,
    actionStartedAt: params.actionStartedAt,
    actionFinishedAt: Date.now(),
    androidFreshnessBaseline: params.androidFreshnessBaseline,
  });
}

function buildIosCorroboratedPayloads(params: {
  target: InteractionTarget;
  resolvedTarget: ResolvedInteractionTarget | undefined;
  warning: string;
  referenceFrame: GestureReferenceFrame | undefined;
  extra: Record<string, unknown> | undefined;
}): InteractionResponsePayloads {
  if (params.resolvedTarget) {
    return buildInteractionResponseData({
      source: {
        kind: 'runtime',
        result: { ...params.resolvedTarget, warning: params.warning },
      },
      referenceFrame: params.referenceFrame,
      extra: params.extra,
    });
  }
  return buildCorroboratedTapResponseData({
    targetKind: params.target.kind,
    point: pointFromInteractionTarget(params.target),
    warning: params.warning,
    referenceFrame: params.referenceFrame,
    extra: {
      ...interactionTargetExtra(params.target),
      ...(params.extra ?? {}),
    },
  });
}

function pointFromInteractionTarget(
  target: InteractionTarget,
): { x: number; y: number } | undefined {
  return target.kind === 'point' ? { x: target.x, y: target.y } : undefined;
}

type RefAdmissionContext = {
  ref: string;
  mintedGeneration: number | undefined;
  staleRefsWarning: string | undefined;
};

type ReadinessOutcome<TResult> =
  | { aborted: true; response: DaemonResponse }
  | {
      aborted: false;
      readiness: AndroidBlockingDialogReadinessResult;
      runtimeResult: TResult;
    };

async function runWithAndroidDialogReadinessCheck<TResult>(
  session: SessionState,
  command: string,
  options: { refContext: RefAdmissionContext | undefined },
  run: () => Promise<TResult>,
): Promise<ReadinessOutcome<TResult>> {
  if (session.lease?.leaseProvider) {
    return { aborted: false, readiness: { status: 'clear' }, runtimeResult: await run() };
  }
  const readiness = await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'before-command',
  });
  // ADR 0014: blocking-dialog recovery is itself device-mutating and expires the
  // frame at its own seam. A ref action admitted against the pre-recovery frame
  // must NOT continue against the recovered UI — abort it through the SHARED
  // admission rejection so the failure shape (reason, ref, currentGeneration,
  // scope, mintedGeneration, hint) is identical to every other expired-frame
  // rejection across platforms. Selector/coordinate actions carry no refContext
  // and re-resolve and continue under their own policy.
  if (options.refContext && readiness.status === 'recovered') {
    const abort = refMutationAdmissionResponse({
      session,
      ref: options.refContext.ref,
      mintedGeneration: options.refContext.mintedGeneration,
      staleRefsWarning: options.refContext.staleRefsWarning,
    });
    if (abort) return { aborted: true, response: abort };
  }
  const runtimeResult = await run();
  await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'after-command',
  });
  return { aborted: false, readiness, runtimeResult };
}

async function refreshAndroidRefSnapshotIfFreshnessActive(
  params: InteractionHandlerParams & {
    captureSnapshotForSession: CaptureSnapshotForSession;
  },
  session: SessionState,
): Promise<SessionState['snapshot']> {
  if (!getActiveAndroidSnapshotFreshness(session)) return undefined;
  const freshnessBaseline =
    session.snapshot?.comparisonSafe === true ? session.snapshot : undefined;
  try {
    await params.captureSnapshotForSession(
      session,
      params.req.flags,
      params.sessionStore,
      params.contextFromFlags,
      { interactiveOnly: true, androidFreshnessMode: 'ref-refresh' },
    );
  } catch (error) {
    emitDiagnostic({
      level: 'warn',
      phase: 'android_ref_snapshot_refresh_failed',
      data: {
        command: params.req.command,
        error: error instanceof Error ? error.message : String(error),
      },
    });
  }
  return freshnessBaseline;
}

function appErrorResponse(error: unknown): DaemonResponse {
  return { ok: false, error: normalizeError(error) };
}

function retryPositionalsForRuntimeResult(
  command: string,
  result: PressCommandResult | FillCommandResult | LongPressCommandResult,
): string[] | undefined {
  if (result.kind === 'ref' && !result.node) return undefined;
  if (command === 'click' || command === 'press') {
    if (!result.point) return undefined;
    return pointPositionals(result.point);
  }
  return undefined;
}

function pointPositionals(point: { x: number; y: number }): string[] {
  return [String(point.x), String(point.y)];
}
