import fs from 'node:fs';
import type { CommandFlags } from '../../core/dispatch.ts';
import {
  mergeReplayVarScopeValues,
  resolveReplayAction,
  type ReplayVarScope,
} from '../../replay/vars.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import { mergeParentFlags } from '../../core/batch.ts';
import { invokeMaestroRuntimeCommand } from '../../compat/maestro/runtime.ts';
import { invokeMaestroRunFlowWhenControl } from '../../compat/maestro/runtime-flow.ts';
import {
  invokeReplayRetryBlock,
  type ReplayActionBlockInvoker,
} from '../../replay/control-flow-runtime.ts';
import { AppError, normalizeError } from '../../kernel/errors.ts';
import {
  gesturePayloadFromPositionals,
  swipePayloadFromPositionals,
} from '../../contracts/gesture-normalization.ts';

type ReplayBaseRequest = Omit<DaemonRequest, 'command' | 'positionals'>;

type ReplayActionInvoker = ReplayActionBlockInvoker;

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
  const invokeNestedReplayAction: ReplayActionInvoker = (nested) =>
    invokeReplayAction({
      req,
      sessionName,
      action: nested.action,
      scope,
      filePath,
      line: nested.line,
      step: nested.step,
      // No recorded source on a nested action = same file as its wrapper.
      sourcePath: nested.sourcePath ?? sourcePath,
      tracePath,
      invoke,
    });
  const startedAt = Date.now();
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_start',
    ts: new Date(startedAt).toISOString(),
    replayPath: filePath,
    ...(sourcePath ? { sourcePath } : {}),
    line,
    step,
    command: resolved.command,
    positionals: resolved.positionals ?? [],
  });

  // A raw dispatch failure (e.g. a selector-miss during press/click/fill/
  // longpress) can THROW an AppError instead of resolving to `{ok:false}` —
  // every caller reachable from here (the top-level replay loop, retry
  // blocks, and nested Maestro runFlow invocations) only ever branches on
  // `response.ok`, so this is the single place every replay action dispatch
  // funnels through, regardless of nesting depth. Normalizing here means the
  // top-level loop's existing `if (!response.ok)` divergence wrapping (and
  // retry/control-flow's own `response.ok` checks) apply uniformly instead of
  // the throw escaping unwrapped to the outer catch.
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
      invokeReplayAction: invokeNestedReplayAction,
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
  invokeReplayAction: ReplayActionInvoker;
}): Promise<DaemonResponse> {
  const { req, sessionName, resolved, scope, line, step, invoke, invokeReplayAction } = params;
  const flags = buildReplayActionFlags(req.flags, resolved.flags);
  const baseReq: ReplayBaseRequest = {
    token: req.token,
    session: sessionName,
    flags,
    runtime: resolved.runtime,
    meta: req.meta,
    internal: req.internal,
  };
  const response =
    (await invokeReplayControl({
      control: resolved.replayControl,
      baseReq,
      line,
      step,
      invoke,
      invokeReplayAction,
    })) ??
    (await invokeMaestroRuntimeCommand({
      command: resolved.command,
      baseReq,
      positionals: resolved.positionals ?? [],
      scope,
      line,
      step,
      invoke,
      invokeReplayAction,
    })) ??
    (await invoke(buildReplayInteractionRequest(baseReq, resolved)));
  if (response.ok) {
    const outputEnv = readReplayOutputEnv(response.data);
    if (outputEnv) mergeReplayVarScopeValues(scope, outputEnv);
  }
  return response;
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

async function invokeReplayControl(params: {
  control: SessionAction['replayControl'] | undefined;
  baseReq: ReplayBaseRequest;
  line: number;
  step: number;
  invoke: DaemonInvokeFn;
  invokeReplayAction: ReplayActionInvoker;
}): Promise<DaemonResponse | undefined> {
  const { control, baseReq, line, step, invoke, invokeReplayAction } = params;
  if (!control) return undefined;
  switch (control.kind) {
    case 'retry':
      return await invokeReplayRetryBlock({
        actions: control.actions,
        actionSources: control.actionSources,
        maxRetries: control.maxRetries,
        line,
        step,
        invokeReplayAction,
      });
    case 'maestroRunFlowWhen':
      return await invokeMaestroRunFlowWhenControl({
        baseReq,
        control,
        line,
        step,
        invoke,
        invokeReplayAction,
      });
  }
  const _exhaustive: never = control;
  return _exhaustive;
}

function readReplayOutputEnv(data: unknown): Record<string, string> | null {
  if (!data || typeof data !== 'object') return null;
  const raw = (data as { outputEnv?: unknown }).outputEnv;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const entries = Object.entries(raw).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string',
  );
  return entries.length > 0 ? Object.fromEntries(entries) : null;
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

function appendReplayTraceEvent(
  tracePath: string | undefined,
  event: Record<string, unknown>,
): void {
  if (!tracePath) return;
  fs.appendFileSync(tracePath, `${JSON.stringify(event)}\n`);
}

function buildReplayActionFlags(
  parentFlags: CommandFlags | undefined,
  actionFlags: SessionAction['flags'] | undefined,
): CommandFlags {
  return mergeParentFlags(parentFlags, { ...(actionFlags ?? {}) });
}
