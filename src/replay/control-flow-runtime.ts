import type { DaemonResponse, ReplayControlActionSource, SessionAction } from '../daemon/types.ts';

export type ReplayActionBlockInvoker = (params: {
  action: SessionAction;
  line: number;
  step: number;
  /**
   * Resolved source file of the nested action when it differs from the
   * wrapping control action's own file (ADR 0012 migration step 2): a
   * `runFlow` include nested under `retry:`/`runFlow.when:` carries its
   * include's path here (from `replayControl.actionSources`), so a failure
   * inside the wrapped include reports the include's file+line, not the
   * wrapper's. `undefined` falls back to the wrapper's source.
   */
  sourcePath?: string;
}) => Promise<DaemonResponse>;

export async function invokeReplayActionBlock(params: {
  actions: SessionAction[];
  actionSources?: (ReplayControlActionSource | undefined)[];
  line: number;
  step: number;
  invokeReplayAction: ReplayActionBlockInvoker;
}): Promise<DaemonResponse> {
  for (const [index, action] of params.actions.entries()) {
    const source = params.actionSources?.[index];
    const response = await params.invokeReplayAction({
      action,
      line: source?.line ?? params.line,
      step: params.step + index / 1000,
      ...(source?.path ? { sourcePath: source.path } : {}),
    });
    if (!response.ok) return response;
  }
  return { ok: true, data: { ran: params.actions.length } };
}

export async function invokeReplayRetryBlock(params: {
  actions: SessionAction[];
  actionSources?: (ReplayControlActionSource | undefined)[];
  maxRetries: number;
  line: number;
  step: number;
  invokeReplayAction: ReplayActionBlockInvoker;
}): Promise<DaemonResponse> {
  let lastResponse: DaemonResponse | undefined;
  for (let attempt = 0; attempt <= params.maxRetries; attempt += 1) {
    const response = await invokeReplayActionBlock({
      actions: params.actions,
      actionSources: params.actionSources,
      line: params.line,
      step: params.step + attempt,
      invokeReplayAction: params.invokeReplayAction,
    });
    if (response.ok) {
      return { ok: true, data: { attempts: attempt + 1, retried: attempt > 0 } };
    }
    lastResponse = response;
  }
  return (
    lastResponse ?? {
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'retry commands failed.' },
    }
  );
}
