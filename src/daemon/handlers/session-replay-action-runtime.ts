import type { SessionAction } from '@agent-device/contracts/session';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse } from '../types.ts';
import { mergeParentFlags } from '../../core/batch.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import {
  gesturePayloadFromPositionals,
  swipePayloadFromPositionals,
} from '@agent-device/contracts/gesture-normalization';
import { buildDisplayPositionals } from '../session-event-action.ts';
import { appendReplayTraceEvent } from './session-replay-trace.ts';
import { inferFillText } from '../action-utils.ts';
import { readRecordedInputVariableName } from '@agent-device/ad-script';
import { resolveImplicitSessionScope } from '../session-routing.ts';

type ReplayBaseRequest = Omit<DaemonRequest, 'command' | 'positionals'>;

/**
 * #1555 review P1 (second pass, "move variable semantics/planning behind the
 * replay entrypoint"): `resolved` arrives already `${VAR}`-interpolated —
 * the engine's own ONE resolution of this step (`runAdReplay`) — rather than
 * this function resolving `action` itself over a `scope` it used to hold.
 * `action` (the recorded original) is still threaded alongside it for the
 * one daemon-owned, non-interpolation decision that reads it:
 * `readRecordedInputVariableName`'s heuristic below, over the ORIGINAL fill
 * text.
 */
export async function invokeReplayAction(params: {
  req: DaemonRequest;
  sessionName: string;
  action: SessionAction;
  resolved: SessionAction;
  filePath: string;
  line: number;
  step: number;
  /** Resolved source file when it differs from `filePath` (a `runFlow` include's path). */
  sourcePath?: string;
  tracePath?: string;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const {
    req,
    sessionName,
    action,
    resolved,
    filePath,
    line,
    step,
    sourcePath,
    tracePath,
    invoke,
  } = params;
  const startedAt = Date.now();
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_start',
    ts: new Date(startedAt).toISOString(),
    replayPath: filePath,
    ...(sourcePath ? { sourcePath } : {}),
    line,
    step,
    command: resolved.command,
    positionals: buildDisplayPositionals(resolved) ?? [],
  });

  // A raw dispatch failure (e.g. a selector-miss during press/click/fill/
  // longpress) can throw an AppError instead of resolving to `{ok:false}`.
  // Normalize it at the generic replay dispatch boundary so the top-level
  // loop's existing divergence wrapping applies uniformly.
  let response: DaemonResponse;
  try {
    response = await invokeResolvedReplayAction({
      req,
      sessionName,
      resolved,
      sourceAction: action,
      invoke,
    });
  } catch (error) {
    // Only an expected AppError dispatch failure (e.g. a selector-miss) gets
    // normalized into a `{ok:false}` response so the loop's `if
    // (!response.ok)` divergence wrapping applies. A plain TypeError/
    // ReferenceError or other programmer bug must propagate to the outer
    // internal-error path rather than being coerced into a repairable
    // REPLAY_DIVERGENCE that would mask a crash.
    if (!(error instanceof AppError)) throw error;
    response = { ok: false, error: normalizeError(error) };
  }

  const finishedAt = Date.now();
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_stop',
    ts: new Date(finishedAt).toISOString(),
    replayPath: filePath,
    ...(sourcePath ? { sourcePath } : {}),
    line,
    step,
    command: resolved.command,
    ok: response.ok,
    durationMs: finishedAt - startedAt,
    resultTiming: response.ok ? readResponseTiming(response.data) : undefined,
    errorCode: response.ok ? undefined : response.error.code,
  });
  return withReplayFailureSource(response, sourcePath ?? filePath, line);
}

/**
 * Attaches the failing action's resolved source for the top-level failure
 * context; deepest failure wins (never overwrites an inner attachment).
 */
function withReplayFailureSource(
  response: DaemonResponse,
  path: string,
  line: number,
): DaemonResponse {
  if (response.ok) return response;
  if (response.error.details?.replaySource !== undefined) return response;
  return {
    ok: false,
    error: {
      ...response.error,
      details: { ...(response.error.details ?? {}), replaySource: { path, line } },
    },
  };
}

async function invokeResolvedReplayAction(params: {
  req: DaemonRequest;
  sessionName: string;
  resolved: SessionAction;
  sourceAction: SessionAction;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, resolved, sourceAction, invoke } = params;
  const flags = buildReplayActionFlags(req.flags, resolved.flags);
  const recordedInputVariable =
    sourceAction.command === 'fill'
      ? readRecordedInputVariableName(inferFillText(sourceAction))
      : undefined;
  if (recordedInputVariable) flags.recordAs = recordedInputVariable;
  const baseReq: ReplayBaseRequest = {
    token: req.token,
    session: sessionName,
    flags,
    runtime: resolved.runtime,
    meta: req.meta,
    // #1271 stage 2: the single point every replay plan step is dispatched, so
    // the one place authored provenance can be stamped for all of them —
    // annotated or not, target-binding kinds and plain dispatches alike. The
    // repair-segment exclusion (`isInteractiveObservation`,
    // `session-action-recorder.ts`) reads it to keep an authored
    // `get`/`is`/`find`/`snapshot` step in its own healed script while still
    // excluding an interactive diagnostic read of the same command.
    internal: {
      ...req.internal,
      replayPlanStep: true,
      ...(resolved.command === 'open'
        ? {
            resolvedSessionScope:
              req.internal?.resolvedSessionScope ?? resolveImplicitSessionScope(req),
          }
        : {}),
    },
  };
  return await invoke(buildReplayInteractionRequest(baseReq, resolved));
}

function buildReplayInteractionRequest(
  baseReq: ReplayBaseRequest,
  action: SessionAction,
): DaemonRequest {
  const positionals = action.positionals ?? [];
  if (action.command === 'gesture') {
    return {
      ...baseReq,
      command: action.command,
      positionals: [],
      input: gesturePayloadFromPositionals(positionals, baseReq.flags?.pointerCount),
    };
  }
  if (action.command === 'swipe') {
    return {
      ...baseReq,
      command: action.command,
      positionals: [],
      input: swipePayloadFromPositionals(positionals, {
        count: baseReq.flags?.count,
        pauseMs: baseReq.flags?.pauseMs,
        pattern: baseReq.flags?.pattern,
      }),
    };
  }
  return { ...baseReq, command: action.command, positionals };
}

function readResponseTiming(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const timing = (data as { timing?: unknown }).timing;
  if (!timing || typeof timing !== 'object' || Array.isArray(timing)) return undefined;
  return Object.fromEntries(
    Object.entries(timing).filter(([, value]) => {
      const kind = typeof value;
      return kind === 'number' || kind === 'string' || kind === 'boolean';
    }),
  );
}

function buildReplayActionFlags(
  parentFlags: CommandFlags | undefined,
  actionFlags: SessionAction['flags'] | undefined,
): CommandFlags {
  return mergeParentFlags(parentFlags, { ...(actionFlags ?? {}) });
}
