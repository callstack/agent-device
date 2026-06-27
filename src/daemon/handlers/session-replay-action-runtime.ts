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
  tracePath?: string;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, action, scope, filePath, line, step, tracePath, invoke } = params;
  const resolved = resolveReplayAction(action, scope, { file: filePath, line });
  const invokeNestedReplayAction: ReplayActionInvoker = (nested) =>
    invokeReplayAction({
      req,
      sessionName,
      action: nested.action,
      scope,
      filePath,
      line: nested.line,
      step: nested.step,
      tracePath,
      invoke,
    });
  const startedAt = Date.now();
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_start',
    ts: new Date(startedAt).toISOString(),
    replayPath: filePath,
    line,
    step,
    command: resolved.command,
    positionals: resolved.positionals ?? [],
  });

  const response = await invokeResolvedReplayAction({
    req,
    sessionName,
    resolved,
    scope,
    line,
    step,
    invoke,
    invokeReplayAction: invokeNestedReplayAction,
  });

  const finishedAt = Date.now();
  appendReplayTraceEvent(tracePath, {
    type: 'replay_action_stop',
    ts: new Date(finishedAt).toISOString(),
    replayPath: filePath,
    line,
    step,
    command: resolved.command,
    ok: response.ok,
    durationMs: finishedAt - startedAt,
    resultTiming: response.ok ? readResponseTiming(response.data) : undefined,
    errorCode: response.ok ? undefined : response.error.code,
  });
  return response;
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
    (await invoke({
      ...baseReq,
      command: resolved.command,
      positionals: resolved.positionals ?? [],
    }));
  if (response.ok) {
    const outputEnv = readReplayOutputEnv(response.data);
    if (outputEnv) mergeReplayVarScopeValues(scope, outputEnv);
  }
  return response;
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
