import type { DaemonResponse, ReplayControlActionSource, SessionAction } from '../daemon/types.ts';

export type ReplayActionBlockInvoker = (params: {
  action: SessionAction;
  line: number;
  step: number;
  /** From `replayControl.actionSources`; `undefined` = the wrapper's own file. */
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
