import type {
  DaemonInvokeFn,
  DaemonRequest,
  DaemonResponse,
  DaemonResponseData,
} from '../../daemon/types.ts';
import type { DaemonFailureResponse } from '../../daemon/handlers/response.ts';
import type { ReplayActionBlockInvoker } from '../../replay/control-flow-runtime.ts';
import type { ReplayVarScope } from '../../replay/vars.ts';
import type { Point, SnapshotState } from '../../kernel/snapshot.ts';

export type ReplayBaseRequest = Omit<DaemonRequest, 'command' | 'positionals'>;

export type MaestroReplayInvoker = ReplayActionBlockInvoker;

export type MaestroRuntimeInvoke = DaemonInvokeFn;

export type FailedDaemonResponse = DaemonFailureResponse;

const maestroVisibleContextCache = new WeakMap<ReplayVarScope, { selector: string }>();
const maestroRecoverableInteractionCache = new WeakMap<
  ReplayVarScope,
  MaestroRecoverableInteraction
>();

export type MaestroRecoverableInteraction =
  | ({
      kind: 'tap';
    } & MaestroRecoverableTap)
  | ({
      kind: 'swipe';
    } & MaestroRecoverableSwipe);

export type MaestroRecoverableTap = {
  selector: string;
  point: Point;
  options?: {
    childOf?: string;
    index?: number;
  };
};

export type MaestroRecoverableSwipe = {
  command: 'gesture' | 'swipe';
  input: Record<string, unknown>;
};

export function errorResponse(
  code: string,
  message: string,
  details?: Record<string, unknown>,
): FailedDaemonResponse {
  return {
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  };
}

export async function captureMaestroSnapshot(params: {
  baseReq: ReplayBaseRequest;
  invoke: MaestroRuntimeInvoke;
  scope?: ReplayVarScope;
  raw?: boolean;
}): Promise<DaemonResponse> {
  const useRawSnapshot =
    params.raw === true || process.env.AGENT_DEVICE_MAESTRO_RAW_SNAPSHOTS === '1';
  const response = await params.invoke({
    ...params.baseReq,
    command: 'snapshot',
    positionals: [],
    flags: {
      ...params.baseReq.flags,
      noRecord: true,
      ...(useRawSnapshot ? { snapshotRaw: true } : {}),
    },
  });
  return response;
}

export function readSnapshotState(data: DaemonResponseData | undefined): SnapshotState | undefined {
  return Array.isArray(data?.nodes) ? (data as SnapshotState) : undefined;
}

export function rememberMaestroVisibleContext(
  scope: ReplayVarScope | undefined,
  selector: string,
): void {
  if (scope) maestroVisibleContextCache.set(scope, { selector });
}

export function readMaestroVisibleContext(
  scope: ReplayVarScope | undefined,
): { selector: string } | undefined {
  return scope ? maestroVisibleContextCache.get(scope) : undefined;
}

export function clearMaestroVisibleContext(scope: ReplayVarScope | undefined): void {
  if (scope) maestroVisibleContextCache.delete(scope);
}

export function rememberMaestroRecoverableInteraction(
  scope: ReplayVarScope | undefined,
  interaction: MaestroRecoverableInteraction,
): void {
  if (scope) maestroRecoverableInteractionCache.set(scope, interaction);
}

export function consumeMaestroRecoverableInteraction(
  scope: ReplayVarScope | undefined,
): MaestroRecoverableInteraction | undefined {
  if (!scope) return undefined;
  const interaction = maestroRecoverableInteractionCache.get(scope);
  maestroRecoverableInteractionCache.delete(scope);
  return interaction;
}

export function clearMaestroRecoverableInteraction(scope: ReplayVarScope | undefined): void {
  if (scope) maestroRecoverableInteractionCache.delete(scope);
}
