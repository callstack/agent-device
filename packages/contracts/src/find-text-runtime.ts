import type { SessionSurface } from './session-surface.ts';
import type { RuntimeOperationFact } from './platform-runtime.ts';
import type { SnapshotRuntimeExecution } from './snapshot-runtime.ts';

/**
 * A native, tree-independent answer to "is this text on screen right now".
 *
 * `surface` and `appBundleId` are the session facts an owner may need to decide it cannot answer
 * for this request — the daemon does not pre-filter by family, so an owner that has no reading
 * for the current surface reports `found: false` and the caller consults the canonical tree.
 */
export type FindTextInput = Readonly<{
  text: string;
  options?: Readonly<{ appBundleId?: string; surface?: SessionSurface }>;
  execution?: SnapshotRuntimeExecution;
  /** Per-capture cancellation; see `CaptureSnapshotInput.signal`. */
  signal?: AbortSignal;
}>;

/**
 * Deliberately asymmetric and fact-conditional (ADR 0019 §2/§9):
 *
 * - `found: true` is **authoritative** — the owner observed the text and the wait is satisfied.
 * - `found: false` is **not** authoritative. It means "not proven by this owner", and the caller
 *   must still consult the canonical tree in the same poll. An owner that cannot answer at all
 *   reports `false` rather than throwing.
 *
 * Owners advertising this operation have text observations their bulk capture may omit, so the
 * positive reading is required for semantic parity in those owner cells. Owners reporting it
 * unavailable instead rely on their parity-proven capture path.
 */
export type FindTextResult = Readonly<{ found: boolean }>;

export type FindTextRuntimeOperations = Readonly<{
  findText(input: FindTextInput): Promise<FindTextResult>;
}>;

export type FindTextRuntimeOperationFacts = Readonly<{ findText: RuntimeOperationFact }>;

export function findTextRuntimeOperationFacts(
  input: FindTextRuntimeOperationFacts,
): FindTextRuntimeOperationFacts {
  return Object.freeze({ findText: input.findText });
}
