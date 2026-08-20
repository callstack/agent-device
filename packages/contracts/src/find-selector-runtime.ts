import type { ElementSelectorKey } from './interactor-types.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SessionSurface } from './session-surface.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

export type FindSelectorInput = Readonly<{
  selector: Readonly<{ key: ElementSelectorKey; value: string }>;
  options?: Readonly<{ appBundleId?: string; surface?: SessionSurface }>;
  execution?: SnapshotRuntimeExecution;
  signal?: AbortSignal;
}>;

/**
 * A positive native selector observation is authoritative. A negative observation only means the
 * owner did not prove the match; the caller must consult its required canonical capture.
 */
export type FindSelectorResult = Readonly<{ found: boolean }>;

export type FindSelectorRuntimeOperations = Readonly<{
  findSelector(input: FindSelectorInput): Promise<FindSelectorResult>;
}>;

export type FindSelectorRuntimeOperationFacts = Readonly<{
  findSelector: RuntimeOperationFact;
}>;

export function findSelectorRuntimeOperationFacts(
  input: FindSelectorRuntimeOperationFacts,
): FindSelectorRuntimeOperationFacts {
  return Object.freeze({ findSelector: input.findSelector });
}
