import type { Point, SnapshotNode, SnapshotState } from '../../kernel/snapshot.ts';
import {
  findAndroidGboardHandwritingTutorialCancel,
  hasAndroidGboardHandwritingTutorial,
  isAndroidInputMethodSnapshotNode,
} from '../../platforms/android/input-method-overlays.ts';
import { emitDiagnostic } from '../../utils/diagnostics.ts';
import type { MaestroRuntimeInvoke, ReplayBaseRequest } from './runtime-support.ts';

export async function dismissAndroidMaestroBlockingOverlay(params: {
  baseReq: ReplayBaseRequest;
  invoke: MaestroRuntimeInvoke;
  snapshot: SnapshotState;
  targetNode?: SnapshotNode;
  selector: string;
}): Promise<boolean> {
  if (params.baseReq.flags?.platform !== 'android') return false;
  if (isAndroidInputMethodSnapshotNode(params.targetNode)) return false;

  const cancel = findAndroidGboardHandwritingTutorialCancel(params.snapshot);
  if (!cancel?.rect) return false;

  const point = centerPoint(cancel.rect);
  emitDiagnostic({
    level: 'info',
    phase: 'maestro_android_blocking_overlay_dismiss',
    data: {
      selector: params.selector,
      overlay: 'gboard-handwriting-tutorial',
      nodeIndex: cancel.index,
      point,
    },
  });

  const response = await params.invoke({
    ...params.baseReq,
    command: 'click',
    positionals: [String(point.x), String(point.y)],
    flags: {
      ...params.baseReq.flags,
      postGestureStabilization: true,
    },
  });
  return response.ok;
}

export function hasAndroidMaestroBlockingOverlay(params: {
  baseReq: ReplayBaseRequest;
  snapshot: SnapshotState;
  targetNode?: SnapshotNode;
}): boolean {
  if (params.baseReq.flags?.platform !== 'android') return false;
  if (isAndroidInputMethodSnapshotNode(params.targetNode)) return false;
  return hasAndroidGboardHandwritingTutorial(params.snapshot);
}

function centerPoint(rect: NonNullable<SnapshotNode['rect']>): Point {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}
