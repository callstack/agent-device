import type { GestureReferenceFrame } from '../../contracts/scroll-gesture.ts';
import {
  transformInteractionResponseData,
  type InteractionResponseDataTransformCommand,
} from '../../core/interaction-response-data-transform.ts';
import { isApplePlatform, publicPlatformString } from '../../kernel/device.ts';
import { normalizeAppleRunnerResultForResponse } from '../../platforms/apple/core/runner/runner-result-response-normalization.ts';
import {
  buttonTag,
  getClickButtonValidationError,
  resolveClickButton,
} from '../../core/click-button.ts';
import type {
  FillCommandResult,
  InteractionTarget,
  LongPressCommandResult,
  PressCommandResult,
} from '../../contracts/interaction.ts';
import { asAppError, normalizeError } from '../../kernel/errors.ts';
import type { DaemonResponse, SessionState } from '../types.ts';
import { finalizeTouchInteraction, type InteractionHandlerParams } from './interaction-common.ts';
import { markSessionSnapshotRefsIssued, resolveRefStalenessWarning } from '../session-snapshot.ts';
import {
  buildInteractionResponseData,
  type InteractionResponsePayloads,
} from './interaction-touch-response.ts';
import type { CaptureSnapshotForSession } from './interaction-snapshot.ts';
import {
  readSettleRequest,
  settleFlagGuardResponse,
  type RefSnapshotFlagGuardResponse,
} from './interaction-flags.ts';
import {
  readSnapshotNodesReferenceFrame,
  resolveDirectTouchReferenceFrameSafely,
} from './interaction-touch-reference-frame.ts';
import { unsupportedMacOsDesktopSurfaceInteraction } from './interaction-touch-policy.ts';
import { errorResponse, noActiveSessionError, requireCommandSupported } from './response.ts';
import {
  assertAndroidPressStayedInApp,
  isAndroidEscapeError,
} from './interaction-android-escape.ts';
import { createInteractionRuntime } from './interaction-runtime.ts';
import {
  formatTouchTargetLabel,
  parseFillTarget,
  parseLongPressTarget,
  parseTouchTarget,
} from './interaction-touch-targets.ts';
import { getActiveAndroidSnapshotFreshness } from '../android-snapshot-freshness.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import { dispatchCommand, type CommandFlags } from '../../core/dispatch.ts';
import {
  commandSupportsSettleObservation,
  commandSupportsVerifyEvidence,
} from '../../core/command-descriptor/registry.ts';
import {
  isDirectIosSelectorFallbackError,
  readSimpleIosSelectorTarget,
  type DirectIosSelectorTarget,
} from '../direct-ios-selector.ts';
import {
  ensureAndroidBlockingSystemDialogReady,
  type AndroidBlockingDialogReadinessResult,
} from '../android-system-dialog.ts';

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
  // BEFORE any internal recapture (Android freshness refresh, --verify) flips
  // the flag or advances the generation as a side effect of this same command
  // (#1076). Pinned refs (`@e12~s3`) get a precise generation-mismatch
  // warning; plain refs keep the coarse marker warning.
  const staleRefsWarning =
    parsedTarget.target.kind === 'ref'
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
    androidFreshnessBaseline = await refreshAndroidRefSnapshotIfFreshnessActive(params, session);
  }
  const directSelector = readDirectIosSelectorTapTarget({
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
      }),
    afterRun: async (result) => {
      if (session.lease?.leaseProvider) return;
      await assertAndroidPressStayedInApp(
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
}): Promise<TargetedTouchResult> {
  const { runtime, command, target, sessionName, requestId, flags } = params;
  const settle = readSettleRequest(flags);
  if (command === 'longpress') {
    return await runtime.interactions.longPress(target, {
      session: sessionName,
      requestId,
      durationMs: params.durationMs,
      settle,
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
    settleRefsGeneration: settleRefsGenerationIssue(session, result),
  });
}

/**
 * #1101 `--settle`: a settle observation carrying a diff hands the client refs
 * minted from the freshly stored settled tree (added lines carry them), which
 * makes the response ref-issuing like snapshot/find (#1076): the coarse
 * `snapshotRefsStale` marker clears (the same accepted coarse blessing as
 * find's single re-issued ref) and the stored tree's generation rides inside
 * the settle payload for MCP per-ref pinning. Without a diff — never captured,
 * or sparse-quality capture that was not stored — nothing was issued and the
 * staleness machinery is left untouched.
 */
function settleRefsGenerationIssue(
  session: SessionState,
  result: PressCommandResult | FillCommandResult | LongPressCommandResult,
): number | undefined {
  if (!result.settle?.diff) return undefined;
  markSessionSnapshotRefsIssued(session);
  return session.snapshotGeneration;
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
  params: InteractionHandlerParams,
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
  params: InteractionHandlerParams;
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
    const fallbackDetails = directIosSelectorFallbackDetails(selector, data);
    const { result, responseData } = buildInteractionResponseData({
      source: {
        kind: 'runner-payload',
        targetKind: 'selector',
        data,
        publicData,
        point,
        maestroFallbackUsed: fallbackDetails.maestroNonHittableCoordinateFallbackUsed === true,
      },
      referenceFrame: readReferenceFrameFromDirectSelectorTapResult(data),
      extra: {
        ...extra,
        ...fallbackDetails,
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

function directIosSelectorFallbackDetails(
  selector: DirectIosSelectorTarget,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (!selector.allowNonHittableCoordinateFallback) return {};
  const used = data.maestroNonHittableCoordinateFallbackUsed === true;
  return {
    maestroNonHittableCoordinateFallbackAllowed: true,
    maestroNonHittableCoordinateFallbackUsed: used,
    ...(used ? { maestroFallbackReason: 'non-hittable-coordinate' } : {}),
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
  const directResponse = await maybeDispatchDirectIosSelectorFill(
    params,
    session,
    parsedTarget.target,
    parsedTarget.text,
  );
  if (directResponse) return directResponse;

  return await dispatchRuntimeInteraction(params, {
    run: async (runtime) =>
      await runtime.interactions.fill(parsedTarget.target, parsedTarget.text, {
        session: sessionName,
        requestId: req.meta?.requestId,
        delayMs: req.flags?.delayMs,
        verify: req.flags?.verify,
        settle: readSettleRequest(req.flags),
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
// @ref-incompatible flags, and run the Android freshness refresh.
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
  const staleRefsWarning = resolveRefStalenessWarning({
    session,
    ref: target.ref,
    mintedGeneration: refGeneration,
  });
  const invalidRefFlagsResponse = params.refSnapshotFlagGuardResponse('fill', params.req.flags);
  if (invalidRefFlagsResponse) return { response: invalidRefFlagsResponse, staleRefsWarning };
  await refreshAndroidRefSnapshotIfFreshnessActive(params, session);
  return { staleRefsWarning };
}

async function maybeDispatchDirectIosSelectorFill(
  params: InteractionHandlerParams & { captureSnapshotForSession: CaptureSnapshotForSession },
  session: SessionState,
  target: InteractionTarget,
  text: string,
): Promise<DaemonResponse | null> {
  const directSelector = readDirectIosSelectorFillTarget({
    session,
    target,
    flags: params.req.flags,
  });
  if (!directSelector) return null;
  return await dispatchDirectIosSelectorFill(params, session, directSelector, text);
}

function buildFillResponsePayloads(params: {
  session: SessionState;
  result: FillCommandResult;
  text: string;
  flags: CommandFlags | undefined;
  staleRefsWarning: string | undefined;
}): InteractionResponsePayloads {
  const { session, result } = params;
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
    },
    referenceFrame,
    extra: { text: params.text },
    staleRefsWarning: params.staleRefsWarning,
    settleRefsGeneration: settleRefsGenerationIssue(session, result),
  });
}

function readDirectIosSelectorFillTarget(params: {
  session: SessionState;
  target: InteractionTarget;
  flags: CommandFlags | undefined;
}): DirectIosSelectorTarget | null {
  const { session, target, flags } = params;
  if (target.kind !== 'selector') return null;
  if (session.recordSession) return null;
  if (commandSupportsVerifyEvidence('fill') && flags?.verify === true) return null;
  if (commandSupportsSettleObservation('fill') && flags?.settle === true) return null;
  return readDirectSelectorWithMaestroFallback(session, target.selector, flags);
}

async function dispatchDirectIosSelectorFill(
  params: InteractionHandlerParams,
  session: SessionState,
  selector: DirectIosSelectorTarget,
  text: string,
): Promise<DaemonResponse | null> {
  return await dispatchDirectIosSelectorInteraction({
    params,
    session,
    selector,
    command: 'fill',
    positionals: [text],
    extra: { selector: selector.raw, text },
    fallbackPhase: 'ios_direct_selector_fill_fallback',
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
    run(runtime: ReturnType<typeof createInteractionRuntime>): Promise<TResult>;
    afterRun?(result: TResult): Promise<void>;
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
    const { readiness, runtimeResult } = await runWithAndroidDialogReadinessCheck(
      session,
      params.req.command,
      async () => {
        const result = await options.run(runtime);
        await options.afterRun?.(result);
        return result;
      },
    );
    const actionFinishedAt = Date.now();
    const { result, responseData, recordedTarget } = await options.buildPayloads(runtimeResult);
    if (readiness.status === 'recovered') {
      // Append, don't clobber — the builder may already carry a warning
      // (e.g. stale-refs, #1076).
      const warning =
        typeof responseData.warning === 'string'
          ? `${responseData.warning} ${readiness.warning}`
          : readiness.warning;
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
    return appErrorResponse(error);
  }
}

async function runWithAndroidDialogReadinessCheck<TResult>(
  session: SessionState,
  command: string,
  run: () => Promise<TResult>,
): Promise<{
  readiness: AndroidBlockingDialogReadinessResult;
  runtimeResult: TResult;
}> {
  if (session.lease?.leaseProvider) {
    return { readiness: { status: 'clear' }, runtimeResult: await run() };
  }
  const readiness = await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'before-command',
  });
  const runtimeResult = await run();
  await ensureAndroidBlockingSystemDialogReady({
    session,
    command,
    phase: 'after-command',
  });
  return { readiness, runtimeResult };
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
