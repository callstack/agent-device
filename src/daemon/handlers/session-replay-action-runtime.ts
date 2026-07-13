import type { CommandFlags } from '../../core/dispatch.ts';
import { resolveReplayAction, type ReplayVarScope } from '../../replay/vars.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import { mergeParentFlags } from '../../core/batch.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import {
  gesturePayloadFromPositionals,
  swipePayloadFromPositionals,
} from '../../contracts/gesture-normalization.ts';
import { buildDisplayPositionals } from '../session-event-action.ts';
import { appendReplayTraceEvent } from './session-replay-trace.ts';

type ReplayBaseRequest = Omit<DaemonRequest, 'command' | 'positionals'>;

export async function invokeReplayAction(params: {
  req: DaemonRequest;
  sessionName: string;
  action: SessionAction;
  scope: ReplayVarScope;
  filePath: string;
  line: number;
  step: number;
  /** Resolved source file when it differs from `filePath` (a `runFlow` include's path). */
  sourcePath?: string;
  tracePath?: string;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, action, scope, filePath, line, step, sourcePath, tracePath, invoke } =
    params;
  const resolved = resolveReplayAction(action, scope, { file: sourcePath ?? filePath, line });
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
      scope,
      line,
      step,
      invoke,
    });
  } catch (dispatchErr) {
    // Only an expected AppError dispatch failure (e.g. a selector-miss) gets
    // normalized into a `{ok:false}` response so the loop's `if
    // (!response.ok)` divergence wrapping applies. A plain TypeError/
    // ReferenceError or other programmer bug must propagate to the outer
    // internal-error path rather than being coerced into a repairable
    // REPLAY_DIVERGENCE that would mask a crash.
    if (!(dispatchErr instanceof AppError)) throw dispatchErr;
    response = { ok: false, error: normalizeError(dispatchErr) };
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
  scope: ReplayVarScope;
  line: number;
  step: number;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, resolved, invoke } = params;
  const flags = buildReplayActionFlags(req.flags, resolved.flags);
  const baseReq: ReplayBaseRequest = {
    token: req.token,
    session: sessionName,
    flags,
    runtime: resolved.runtime,
    meta: req.meta,
    internal: req.internal,
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
