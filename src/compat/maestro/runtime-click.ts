import type { DaemonResponse } from '../../daemon/types.ts';
import type { Point } from '../../kernel/snapshot.ts';
import type { MaestroRuntimeInvoke, ReplayBaseRequest } from './runtime-support.ts';

export async function invokeMaestroClickPoint(params: {
  baseReq: ReplayBaseRequest;
  invoke: MaestroRuntimeInvoke;
  point: Point;
}): Promise<DaemonResponse> {
  return await params.invoke({
    ...params.baseReq,
    command: 'click',
    positionals: [String(params.point.x), String(params.point.y)],
    flags: {
      ...params.baseReq.flags,
      postGestureStabilization: true,
    },
  });
}
