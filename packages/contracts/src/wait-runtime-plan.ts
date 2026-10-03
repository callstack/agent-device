/** The normalized wait target, independent of the positional grammar that produced it. */
export type WaitRuntimeTarget = 'sleep' | 'text' | 'ref' | 'selector' | 'absent' | 'stable';

/**
 * Which wait shapes reach a device at all. A duration wait observes nothing, so it never asks
 * for a plan and therefore never admits or binds — the absence of platform execution for that
 * shape is stated here rather than left as an incidental branch in the handler.
 *
 * Every other shape polls the selector family's wait-observation capture plan. The binder remains
 * shared, but wait's correctness-bearing conditionals are absent from capture-only and element-text
 * uses, so unrelated commands cannot be rejected for operations they never execute.
 */
export function waitObservesDevice(target: WaitRuntimeTarget): boolean {
  return target !== 'sleep';
}
