import type { DeviceInfo } from '@agent-device/kernel/device';
import type { Point } from '@agent-device/kernel/snapshot';
import type { RunnerContext } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SessionSurface } from './session-surface.ts';

/** Runner metadata the selected read implementation needs, without request-owned state. */
export type ElementTextRuntimeExecution = Readonly<Omit<RunnerContext, 'appBundleId' | 'signal'>>;

/**
 * Neutral intent for one point-addressed element read. The point is already resolved from the
 * node the caller matched, so the operation names no command, request, session, or CLI flag.
 */
export type ReadTextAtPointInput = Readonly<{
  point: Point;
  options?: Readonly<{ appBundleId?: string; surface?: SessionSurface }>;
  execution?: ElementTextRuntimeExecution;
}>;

export type ElementTextRuntimeOperations = Readonly<{
  /**
   * The live text an owner reads at a point, which can exceed the readable text carried by an
   * already-captured snapshot node (an editable field whose value is longer than its label).
   * Declared `preferred`, never `required`: every consumer's required path answers from the
   * snapshot tree, so an owner without this operation still executes the command completely.
   */
  readTextAtPoint(input: ReadTextAtPointInput): Promise<string>;
}>;

export type ElementTextRuntimeOperationFacts = Readonly<{
  readTextAtPoint: RuntimeOperationFact;
}>;

export function elementTextRuntimeOperationFacts(
  input: ElementTextRuntimeOperationFacts,
): ElementTextRuntimeOperationFacts {
  return Object.freeze({ readTextAtPoint: input.readTextAtPoint });
}

/**
 * The existing per-family read mechanics, injected by composition. Families reach their own
 * tools through this port rather than importing root modules, matching the snapshot runtime's
 * interactor-resolver seam.
 */
export type ElementTextRuntimeHost = Readonly<{
  readTextAtPoint(device: DeviceInfo, input: ReadTextAtPointInput): Promise<string>;
}>;

/** Captures one selected owner's read authority for the lifetime of a request binding. */
export function bindElementTextRuntime(
  params: Readonly<{
    device: DeviceInfo;
    host: ElementTextRuntimeHost;
  }>,
): ElementTextRuntimeOperations {
  return Object.freeze({
    readTextAtPoint: async (input: ReadTextAtPointInput) =>
      await params.host.readTextAtPoint(params.device, input),
  });
}
