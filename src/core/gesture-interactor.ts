import type { GesturePlan, MultiTouchGesturePlan } from './gesture-plan-types.ts';
import type { Interactor } from './interactor-types.ts';

export type GestureInteractor = Interactor & {
  performGesture(plan: GesturePlan): Promise<Record<string, unknown> | void>;
};

export function withGesturePerformer(interactor: Interactor): GestureInteractor {
  if (interactor.performGesture) return interactor as GestureInteractor;
  interactor.performGesture = async (plan) => await performLegacyGesture(interactor, plan);
  return interactor as GestureInteractor;
}

async function performLegacyGesture(
  interactor: Interactor,
  plan: GesturePlan,
): Promise<Record<string, unknown> | void> {
  if (plan.topology === 'single') {
    const samples = plan.pointers[0].samples;
    const start = samples[0]?.point;
    const end = samples.at(-1)?.point;
    if (!start || !end) throw new Error('Gesture plan requires start and end samples');
    switch (plan.intent) {
      case 'swipe':
        return await interactor.swipe(start.x, start.y, end.x, end.y, plan.durationMs);
      case 'pan':
        return await interactor.pan(start.x, start.y, end.x, end.y, plan.durationMs);
      case 'fling':
        return await interactor.fling(start.x, start.y, end.x, end.y, plan.durationMs);
    }
  }

  return await performLegacyMultiTouchGesture(interactor, plan);
}

async function performLegacyMultiTouchGesture(
  interactor: Interactor,
  plan: MultiTouchGesturePlan,
): Promise<Record<string, unknown> | void> {
  const { start, end } = plan.centroid;
  switch (plan.intent) {
    case 'pinch':
      return await interactor.pinch(plan.scale, start.x, start.y);
    case 'rotate':
      return await interactor.rotateGesture(
        plan.rotationDegrees,
        start.x,
        start.y,
        plan.velocity ?? (plan.rotationDegrees >= 0 ? 1 : -1),
      );
    case 'pan':
    case 'transform':
      return await interactor.transformGesture({
        x: start.x,
        y: start.y,
        dx: end.x - start.x,
        dy: end.y - start.y,
        scale: plan.scale,
        degrees: plan.rotationDegrees,
        durationMs: plan.durationMs,
      });
  }
}
