import type { DeviceInfo } from '@agent-device/kernel/device';
import { bindElementTextRuntime } from './element-text-runtime.ts';
import { bindLocalFocusInteractor } from './focus-runtime.ts';
import { bindLocalGestureInteractor } from './gesture-runtime.ts';
import { bindAdmittedLocalInteractorOperations } from './interactor-operation-catalog.ts';
import type { LocalInteractorOperationResolver } from './interactor-operation-binding.ts';
import type { PlatformRuntimeOperations } from './platform-runtime-operations.ts';
import { whenAdmitted, type RuntimeFacts } from './platform-runtime.ts';
import { bindLocalScreenshotInteractor } from './screenshot-runtime.ts';
import { bindLocalScrollInteractor } from './scroll-runtime.ts';
import { bindLocalTouchInteractor } from './touch-runtime.ts';
import { bindLocalTypeTextInteractor } from './type-text-runtime.ts';

/**
 * The whole local interactor-backed operation set a pointer-driving family binds: the uniform
 * one-fact-one-bind leaves the interactor catalog walks, plus the four that carry extra input of their own — gesture and touch read the
 * fact map, and touch needs a pause clock. Android and Linux each held a byte-identical copy of
 * this list; it is one list now, so neither family can drift from the other by forgetting a
 * member. Capture stays out: an owner's snapshot mechanics are its own (Linux captures a surface
 * through its host, Android drives the interactor), so there is no shared reading to make.
 */
export function bindLocalInteractorOperationSet(
  params: Readonly<{
    device: DeviceInfo;
    signal: AbortSignal;
    resolveInteractor: LocalInteractorOperationResolver;
    facts: RuntimeFacts<PlatformRuntimeOperations>['operations'];
    pause: (milliseconds: number) => Promise<void>;
  }>,
): Partial<PlatformRuntimeOperations> {
  const { facts, pause } = params;
  const resolver = {
    device: params.device,
    signal: params.signal,
    resolveInteractor: params.resolveInteractor,
  };
  return {
    ...(facts.captureScreenshot.available ? bindLocalScreenshotInteractor(resolver) : {}),
    ...(facts.focusPoint.available ? bindLocalFocusInteractor(resolver) : {}),
    ...bindLocalGestureInteractor({ ...resolver, facts }),
    ...(facts.scrollDirection.available ? bindLocalScrollInteractor(resolver) : {}),
    ...(facts.typeText.available ? bindLocalTypeTextInteractor(resolver) : {}),
    ...(facts.readTextAtPoint.available ? bindElementTextRuntime(resolver) : {}),
    ...whenAdmitted(facts.tapPoint, () => bindLocalTouchInteractor({ ...resolver, facts, pause })),
    ...bindAdmittedLocalInteractorOperations({ ...resolver, facts }),
  };
}
