import type { FocusPointInput } from '@agent-device/contracts/focus-runtime';
import { focusRuntimeUse } from '@agent-device/contracts/platform-runtime-operations';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Point } from '@agent-device/kernel/snapshot';
import { successText } from '../utils/success-text.ts';
import { readPointPositionals } from '../utils/validation.ts';
import type { DaemonCommandContext } from './context.ts';
import type { ResolvedGenericExecution } from './request-generic-dispatch.ts';
import { resolveBoundGenericRuntime, type RuntimeAdmissionBindings } from './runtime-admission.ts';
import { runtimeExecutionFromContext } from './snapshot-runtime-capture-input.ts';

/** `focus x y`, on the same positional parse its still-legacy touch siblings take. */
export function readFocusPoint(positionals: readonly string[]): Point {
  return readPointPositionals(positionals, 'focus requires x y');
}

/** The neutral intent one focus carries, projected from a resolved command context. */
function focusPointInput(point: Point, context: DaemonCommandContext): FocusPointInput {
  return {
    point,
    ...(context.appBundleId === undefined ? {} : { options: { appBundleId: context.appBundleId } }),
    execution: runtimeExecutionFromContext(context),
  };
}

/**
 * The one place `focus` reaches a device (ADR 0019). Admission inspects the exact owner's
 * `focusPoint` fact and binds once, before the dispatcher runs, so an owner that cannot drive
 * touch is refused rather than discovered mid-execution.
 */
export async function resolveBoundFocusRuntime(
  params: {
    device: DeviceInfo;
    positionals: readonly string[];
  } & RuntimeAdmissionBindings,
): Promise<ResolvedGenericExecution> {
  const point = readFocusPoint(params.positionals);
  return await resolveBoundGenericRuntime(
    {
      command: 'focus',
      device: params.device,
      use: focusRuntimeUse,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    },
    (runtime, context) => executeFocusPoint(runtime, point, context),
  );
}

/**
 * The ONE place a bound `focusPoint` executes (R40; also find's focus leg, which passes the
 * operations of its own action-selected bind). Keeping the operation call in a single lexical
 * owner is what lets the cutover gate prove no parallel route exists.
 */
export async function executeFocusPoint(
  runtime: Readonly<{
    operations: Readonly<{ focusPoint: (input: FocusPointInput) => Promise<void> }>;
  }>,
  point: Point,
  context: DaemonCommandContext,
): Promise<Record<string, unknown>> {
  await runtime.operations.focusPoint(focusPointInput(point, context));
  return { x: point.x, y: point.y, ...successText(`Focused (${point.x}, ${point.y})`) };
}
