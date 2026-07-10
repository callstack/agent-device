import type { DaemonInvokeFn, DaemonResponse, SessionReplayControl } from '../../daemon/types.ts';
import { getSnapshotReferenceFrame } from '../../daemon/touch-reference-frame.ts';
import { invokeReplayActionBlock } from '../../replay/control-flow-runtime.ts';
import {
  captureMaestroSnapshot,
  errorResponse,
  readSnapshotState,
  type MaestroReplayInvoker,
  type ReplayBaseRequest,
} from './runtime-support.ts';
import {
  readMaestroSelectorPlatform,
  resolveVisibleMaestroNodeFromSnapshot,
} from './runtime-targets.ts';
import { sleep } from '../../utils/timeouts.ts';

const MAESTRO_RUN_FLOW_WHEN_POLICY = {
  visibleTimeoutMs: 3000,
  visiblePollMs: 250,
} as const;

type MaestroRunFlowWhenControl = Extract<SessionReplayControl, { kind: 'maestroRunFlowWhen' }>;

export async function invokeMaestroRunFlowWhenControl(params: {
  baseReq: ReplayBaseRequest;
  control: MaestroRunFlowWhenControl;
  line: number;
  step: number;
  invoke: DaemonInvokeFn;
  invokeReplayAction: MaestroReplayInvoker;
}): Promise<DaemonResponse> {
  const conditionResult = await evaluateMaestroRunFlowWhenCondition(params, params.control);
  if (!conditionResult.ok) return conditionResult.response;
  if (!conditionResult.matched) {
    return {
      ok: true,
      data: { skipped: true, condition: params.control.mode, selector: params.control.selector },
    };
  }
  return await invokeMaestroRunFlowWhenSteps(params);
}

async function evaluateMaestroRunFlowWhenCondition(
  params: {
    baseReq: ReplayBaseRequest;
    invoke: DaemonInvokeFn;
  },
  condition: MaestroRunFlowWhenControl,
): Promise<{ ok: true; matched: boolean } | { ok: false; response: DaemonResponse }> {
  if (condition.mode === 'visible') {
    return await waitForMaestroRunFlowVisibleCondition(params, condition);
  }

  const result = await readMaestroRunFlowVisibleCondition(params, condition.selector);
  if (!result.ok) {
    return {
      ok: false,
      response: result.response,
    };
  }
  return { ok: true, matched: !result.matched };
}

async function waitForMaestroRunFlowVisibleCondition(
  params: {
    baseReq: ReplayBaseRequest;
    invoke: DaemonInvokeFn;
  },
  condition: MaestroRunFlowWhenControl,
): Promise<{ ok: true; matched: boolean } | { ok: false; response: DaemonResponse }> {
  // Maestro conditionals commonly guard UI that appears immediately after the
  // previous command. Keep this bounded and only for visible; notVisible stays
  // a point-in-time condition so optional cleanup blocks do not become waits.
  const startedAt = Date.now();
  while (true) {
    const result = await readMaestroRunFlowVisibleCondition(params, condition.selector);
    if (!result.ok) return { ok: false, response: result.response };
    if (result.matched) return { ok: true, matched: true };
    if (Date.now() - startedAt >= MAESTRO_RUN_FLOW_WHEN_POLICY.visibleTimeoutMs) {
      return { ok: true, matched: false };
    }
    await sleep(MAESTRO_RUN_FLOW_WHEN_POLICY.visiblePollMs);
  }
}

async function readMaestroRunFlowVisibleCondition(
  params: {
    baseReq: ReplayBaseRequest;
    invoke: DaemonInvokeFn;
  },
  selector: string,
): Promise<{ ok: true; matched: boolean } | { ok: false; response: DaemonResponse }> {
  const response = await captureMaestroSnapshot(params);
  if (!response.ok) return { ok: false, response };
  return resolveMaestroRunFlowVisibleCondition(params, selector, response);
}

function resolveMaestroRunFlowVisibleCondition(
  params: {
    baseReq: ReplayBaseRequest;
  },
  selector: string,
  response: Extract<DaemonResponse, { ok: true }>,
): { ok: true; matched: boolean } | { ok: false; response: DaemonResponse } {
  const snapshot = readSnapshotState(response.data);
  if (!snapshot) {
    return {
      ok: false,
      response: errorResponse('COMMAND_FAILED', 'Unable to read snapshot data for runFlow.when.'),
    };
  }
  const matched = resolveVisibleMaestroNodeFromSnapshot(
    snapshot,
    selector,
    readMaestroSelectorPlatform(params.baseReq.flags),
    getSnapshotReferenceFrame(snapshot),
  ).ok;
  return { ok: true, matched };
}

async function invokeMaestroRunFlowWhenSteps(params: {
  control: MaestroRunFlowWhenControl;
  line: number;
  step: number;
  invokeReplayAction: MaestroReplayInvoker;
}): Promise<DaemonResponse> {
  const response = await invokeReplayActionBlock({
    actions: params.control.actions,
    actionSources: params.control.actionSources,
    line: params.line,
    step: params.step,
    invokeReplayAction: params.invokeReplayAction,
  });
  if (!response.ok) return response;

  return {
    ok: true,
    data: {
      ran: response.data?.ran,
      condition: params.control.mode,
      selector: params.control.selector,
    },
  };
}
