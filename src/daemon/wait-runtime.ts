import { waitObservesDevice } from '@agent-device/contracts/wait-runtime-plan';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { AppError } from '@agent-device/kernel/errors';
import { checkWaitText } from '@agent-device/selectors';
import { parseWaitPositionals } from '../core/wait-positionals.ts';
import type { WaitParsed } from '../core/wait-positionals.ts';
import { absenceCaptureOptionError } from '../core/absence-observation-errors.ts';
import { absenceCaptureOptionRefusal } from '../core/absence-observation.ts';
import { parseVersionedRefPositional } from './ref-positionals.ts';
import { errorResponse } from './response.ts';
import { resolveRefStalenessWarning } from './session-snapshot.ts';
import { resolveSessionDevice, withSessionlessRunnerCleanup } from './snapshot-session.ts';
import { recordIfSession, stripResolutionPayload, toDaemonWaitData } from './selector-recording.ts';
import {
  resolveBoundSelectorCapture,
  type BoundSelectorOperations,
} from './selector-capture-binding.ts';
import {
  consumedSessionSnapshot,
  maybeAndroidForegroundBlockerResponse,
  readRecordedResolutionTarget,
  toDaemonResponse,
} from './selector-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from './request-runtime-binding.ts';
import type { DaemonRequest, DaemonResponse, SessionState } from './types.ts';
import { dispatchConditionalWaitSelector } from './wait-conditional-selector.ts';
import { maybeWaitTimeoutSurfaceResponse } from './wait-current-surface.ts';
import { withSystemSurfaceDisclosure } from './system-surface-disclosure.ts';
import {
  createSelectorRuntimeForDevice,
  type SelectorRuntimeParams,
} from './selector-runtime-backend.ts';

type DispatchWaitParams = SelectorRuntimeParams &
  Readonly<{ inspectFacts?: InspectDeviceRuntimeFacts; bindDevice?: BindDeviceRuntime }>;

export async function dispatchWaitViaRuntime(params: DispatchWaitParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const parsedOrResponse = parseWaitRequest(req);
  if ('ok' in parsedOrResponse) return parsedOrResponse;
  const parsed = parsedOrResponse;
  const { session, device } = await resolveSessionDevice(sessionStore, sessionName, req.flags);
  // ADR 0019: facts are the only support authority, through the selector family's one
  // admit-then-bind entry. A duration wait observes nothing, so it never asks for a binding —
  // exactly the cell legacy admission skipped by testing `parsed.kind !== 'sleep'`.
  const boundOrResponse = await bindWaitOperations(params, parsed, session, device);
  if (boundOrResponse && 'ok' in boundOrResponse) return boundOrResponse;
  const waitOperations = boundOrResponse;
  // ADR 0012 / #1349, replay-only: the recorded landmark identity this wait must observe.
  const recordedLandmark = req.internal?.replayLandmarkGuard;
  const normalized = normalizeWaitPositionals(parsed, session);
  if ('ok' in normalized) return normalized;
  const { waitParsed, staleRefsWarning } = normalized;
  const conditionalResponse = await dispatchConditionalWaitIfNeeded(
    params,
    waitParsed,
    session,
    waitOperations,
    recordedLandmark,
  );
  if (conditionalResponse) return conditionalResponse;
  // Wait builds its runtime directly (no createBoundSelectorRuntime), so the consumed-snapshot slot
  // must be initialized here too or sessionless waits have nowhere to report the capture from.
  params.consumedSnapshot ??= {};
  // A pure sleep consumes no capture, so it never earns the system-surface disclosure below.
  if (parsed.kind === 'sleep') {
    return await executeWaitRequest(
      params,
      waitParsed,
      session,
      device,
      waitOperations,
      staleRefsWarning,
      recordedLandmark,
    );
  }
  // Both a satisfied wait and a timeout consumed the polled capture stored on the session:
  // when it is an occluding system surface, the outcome must disclose the occlusion.
  return withSystemSurfaceDisclosure(
    await withSessionlessRunnerCleanup(
      session,
      device,
      () =>
        executeWaitRequest(
          params,
          waitParsed,
          session,
          device,
          waitOperations,
          staleRefsWarning,
          recordedLandmark,
        ),
      params.platformResourceCleanup,
    ),
    consumedSessionSnapshot(params),
  );
}

function parseWaitRequest(
  req: DaemonRequest,
): Exclude<WaitParsed, { kind: 'invalid' }> | DaemonResponse {
  const parsed = parseWaitPositionals(req.positionals ?? []);
  if (!parsed) return errorResponse('INVALID_ARGS', 'wait requires a duration or text');
  if (parsed.kind === 'invalid') return errorResponse('INVALID_ARGS', parsed.message);
  if (parsed.kind !== 'absent') return parsed;
  const refusedOption = absenceCaptureOptionRefusal({
    depth: req.flags?.snapshotDepth,
    scope: req.flags?.snapshotScope,
  });
  if (!refusedOption) return parsed;
  const error = absenceCaptureOptionError(refusedOption, 'wait');
  return errorResponse(error.code, error.message, error.details);
}

async function bindWaitOperations(
  params: DispatchWaitParams,
  parsed: Exclude<WaitParsed, { kind: 'invalid' }>,
  session: SessionState | undefined,
  device: SessionState['device'],
): Promise<BoundSelectorOperations | DaemonResponse | undefined> {
  if (!waitObservesDevice(parsed.kind)) return undefined;
  const bound = await resolveBoundSelectorCapture({
    command: 'wait',
    device,
    session,
    inspectFacts: params.inspectFacts,
    bindDevice: params.bindDevice,
  });
  return bound.ok ? bound.operations : bound.response;
}

type NormalizedWaitPositionals = {
  waitParsed: Exclude<WaitParsed, { kind: 'invalid' }>;
  staleRefsWarning?: string;
};

function normalizeWaitPositionals(
  parsed: Exclude<WaitParsed, { kind: 'invalid' }>,
  session: SessionState | undefined,
): NormalizedWaitPositionals | DaemonResponse {
  if (parsed.kind !== 'ref') return { waitParsed: parsed };
  const versionedRef = parseVersionedRefPositional(parsed.rawRef);
  if (!versionedRef.ok) return versionedRef.response;
  return {
    waitParsed: { ...parsed, rawRef: versionedRef.ref },
    staleRefsWarning: resolveRefStalenessWarning({
      session,
      ref: versionedRef.ref,
      mintedGeneration: versionedRef.generation,
    }),
  };
}

async function dispatchConditionalWaitIfNeeded(
  params: DispatchWaitParams,
  parsed: Exclude<WaitParsed, { kind: 'invalid' }>,
  session: SessionState | undefined,
  waitOperations: BoundSelectorOperations | undefined,
  recordedLandmark: TargetAnnotationV1 | undefined,
): Promise<DaemonResponse | null> {
  if (parsed.kind !== 'selector') return null;
  return await dispatchConditionalWaitSelector({
    selectorExpression: parsed.selectorExpression,
    operation: waitOperations?.findSelector,
    recordedLandmark,
    req: params.req,
    session,
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
    logPath: params.logPath,
    signal: params.signal,
  });
}

async function executeWaitRequest(
  params: DispatchWaitParams,
  parsed: Exclude<WaitParsed, { kind: 'invalid' }>,
  session: SessionState | undefined,
  device: SessionState['device'],
  waitOperations: BoundSelectorOperations | undefined,
  staleRefsWarning: string | undefined,
  recordedLandmark: TargetAnnotationV1 | undefined,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const runtime = createSelectorRuntimeForDevice({
    ...params,
    session,
    device,
    bound: waitOperations,
  });
  const response = await toDaemonResponse(async () => {
    const result = await runtime.selectors.wait({
      session: sessionName,
      requestId: req.meta?.requestId,
      target: toWaitTarget(parsed, session, recordedLandmark),
    });
    const recordedTarget = readRecordedResolutionTarget(result);
    recordIfSession(
      sessionStore,
      sessionName,
      req,
      stripResolutionPayload(result),
      recordedTarget,
      'landmark',
    );
    const data = toDaemonWaitData(result);
    return staleRefsWarning ? { ...data, warning: staleRefsWarning } : data;
  });
  const enrichedResponse = waitOperations
    ? await maybeWaitTimeoutSurfaceResponse(
        { req, logPath: params.logPath, session, device, capture: waitOperations.capture },
        response,
      )
    : response;
  return await maybeAndroidForegroundBlockerResponse(params, enrichedResponse, 'wait');
}

function toWaitTarget(
  // 'invalid' is rejected by the caller before this point; excluding it here makes the
  // kind-by-kind narrowing below exhaustive without a runtime fallback branch (#1800).
  parsed: Exclude<WaitParsed, { kind: 'invalid' }>,
  session: SessionState | undefined,
  recordedLandmark?: TargetAnnotationV1,
) {
  switch (parsed.kind) {
    case 'sleep':
      return { kind: 'sleep' as const, durationMs: parsed.durationMs };
    case 'selector':
      return {
        kind: 'selector' as const,
        selector: parsed.selectorExpression,
        timeoutMs: parsed.timeoutMs,
        ...(recordedLandmark ? { recordedLandmark } : {}),
      };
    case 'absent':
      return {
        kind: 'absent' as const,
        selector: parsed.selectorExpression,
        timeoutMs: parsed.timeoutMs,
      };
    case 'ref':
      return toRefWaitTarget(parsed, session);
    case 'stable':
      return {
        kind: 'stable' as const,
        quietMs: parsed.quietMs,
        timeoutMs: parsed.timeoutMs,
      };
    case 'text': {
      return toTextWaitTarget(parsed);
    }
    default:
      return assertNever(parsed);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported wait positional target: ${String(value)}`);
}

function toRefWaitTarget(
  parsed: Extract<WaitParsed, { kind: 'ref' }>,
  session: SessionState | undefined,
) {
  if (!session?.snapshot) {
    throw new AppError('INVALID_ARGS', 'Ref wait requires an existing snapshot in session.');
  }
  return { kind: 'ref' as const, ref: parsed.rawRef, timeoutMs: parsed.timeoutMs };
}

function toTextWaitTarget(parsed: Extract<WaitParsed, { kind: 'text' }>) {
  const waitText = checkWaitText(parsed.text);
  if (!waitText.ok) throw new AppError(waitText.code, waitText.message);
  return { kind: 'text' as const, text: waitText.text, timeoutMs: parsed.timeoutMs };
}
