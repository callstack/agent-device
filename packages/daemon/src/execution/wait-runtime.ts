import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { sleep } from '@agent-device/host-kit/retry';
import { getRequestSignal } from '@agent-device/host-kit/request';
import type { TargetAnnotationV1 } from '@agent-device/contracts/replay';
import { AppError } from '@agent-device/kernel/errors';
import { checkWaitText } from '@agent-device/selectors';
import { parseWaitPositionals } from '@agent-device/command-registry/wait-positionals';
import type { WaitParsed } from '@agent-device/command-registry/wait-positionals';
import { absenceCaptureOptionError } from '@agent-device/selectors/absence-observation-errors';
import { absenceCaptureOptionRefusal } from '@agent-device/selectors/absence-observation';
import { parseVersionedRefPositional } from './ref-positionals.ts';
import { resolveRefStalenessWarning } from './session-snapshot.ts';
import {
  resolveSessionAtAddress,
  resolveSessionDevice,
  withSessionlessRunnerCleanup,
} from '../core/snapshot-session.ts';
import {
  recordIfSession,
  stripResolutionPayload,
  toDaemonWaitData,
} from '../core/selector-recording.ts';
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
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../core/request-runtime-binding.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';
import type { SessionRef, SessionState } from '../core/session-state.ts';
import { maybeWaitTimeoutSurfaceResponse } from './wait-current-surface.ts';
import { withCaptureDisclosures } from '../core/capture-disclosure.ts';
import {
  createSelectorRuntimeForDevice,
  type SelectorRuntimeParams,
} from './selector-runtime-backend.ts';
import { errorResponse } from '@agent-device/kernel/contracts';

type DispatchWaitParams = SelectorRuntimeParams &
  Readonly<{ inspectFacts?: InspectDeviceRuntimeFacts; bindDevice?: BindDeviceRuntime }>;

type ObservingWait = Exclude<WaitParsed, { kind: 'invalid' | 'sleep' }>;

export async function dispatchWaitViaRuntime(params: DispatchWaitParams): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const parsedOrResponse = parseWaitRequest(req);
  if ('ok' in parsedOrResponse) return parsedOrResponse;
  const parsed = parsedOrResponse;
  if (parsed.kind === 'sleep') return await executeDurationWait(params, parsed.durationMs);
  const { ref, session, device } = await resolveSessionDevice(sessionStore, sessionName, req);
  const bound = await resolveBoundSelectorCapture({
    command: 'wait',
    device,
    session,
    inspectFacts: params.inspectFacts,
    platformServices: params.platformServices,
    bindDevice: params.bindDevice,
  });
  if (!bound.ok) return bound.response;
  const waitOperations = bound.operations;
  // ADR 0012 / #1349, replay-only: the recorded landmark identity this wait must observe.
  const recordedLandmark = req.internal?.replayLandmarkGuard;
  const normalized = normalizeWaitPositionals(parsed, session);
  if ('ok' in normalized) return normalized;
  const { waitParsed, staleRefsWarning } = normalized;
  // Wait builds its runtime directly (no createBoundSelectorRuntime), so the consumed-snapshot slot
  // must be initialized here too or sessionless waits have nowhere to report the capture from.
  params.consumedSnapshot ??= {};
  params.captureProof ??= {};
  // Both a satisfied wait and a timeout consumed the polled capture stored on the session:
  // when it is an occluding system surface, the outcome must disclose the occlusion.
  return withCaptureDisclosures({
    response: await withSessionlessRunnerCleanup(
      session,
      device,
      () =>
        executeWaitRequest(
          { ...params, ref },
          waitParsed,
          session,
          device,
          waitOperations,
          staleRefsWarning,
          recordedLandmark,
        ),
      params.platformResourceCleanup,
    ),
    consumedTree: consumedSessionSnapshot(params),
    captureProof: params.captureProof,
  });
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

async function executeDurationWait(
  params: DispatchWaitParams,
  durationMs: number,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const { ref } = await resolveSessionAtAddress(sessionStore, sessionName, req);
  return await toDaemonResponse(async () => {
    const signal = params.signal ?? getRequestSignal(req.meta?.requestId);
    signal?.throwIfAborted();
    if (durationMs > 0) await sleep(durationMs, signal);
    signal?.throwIfAborted();
    const result = { kind: 'sleep', waitedMs: durationMs };
    recordIfSession(sessionStore, ref, req, result, undefined, 'landmark');
    return toDaemonWaitData(result);
  });
}

type NormalizedWaitPositionals = {
  waitParsed: ObservingWait;
  staleRefsWarning?: string;
};

function normalizeWaitPositionals(
  parsed: ObservingWait,
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

async function executeWaitRequest(
  params: DispatchWaitParams & { ref: SessionRef | undefined },
  parsed: ObservingWait,
  session: SessionState | undefined,
  device: SessionState['device'],
  waitOperations: BoundSelectorOperations,
  staleRefsWarning: string | undefined,
  recordedLandmark: TargetAnnotationV1 | undefined,
): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const runtime = await createSelectorRuntimeForDevice({
    ...params,
    ref: params.ref,
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
      params.ref,
      req,
      stripResolutionPayload(result),
      recordedTarget,
      'landmark',
    );
    const data = toDaemonWaitData(result);
    return staleRefsWarning ? { ...data, warning: staleRefsWarning } : data;
  });
  const enrichedResponse = await maybeWaitTimeoutSurfaceResponse(
    {
      req,
      logPath: params.logPath,
      session,
      device,
      capture: waitOperations.capture,
      captureProof: params.captureProof,
    },
    response,
  );
  return await maybeAndroidForegroundBlockerResponse(params, enrichedResponse, 'wait');
}

function toWaitTarget(
  parsed: ObservingWait,
  session: SessionState | undefined,
  recordedLandmark?: TargetAnnotationV1,
) {
  switch (parsed.kind) {
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
