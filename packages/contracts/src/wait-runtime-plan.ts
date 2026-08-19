/** The normalized wait target, independent of the positional grammar that produced it. */
export type WaitRuntimeTarget = 'sleep' | 'text' | 'ref' | 'selector' | 'stable';

/**
 * Which wait shapes reach a device at all. A duration wait observes nothing, so it never asks
 * for a plan and therefore never admits or binds — the absence of platform execution for that
 * shape is stated here rather than left as an incidental branch in the handler.
 *
 * Every other shape polls the selector family's ordinary capture plan
 * (`resolveSelectorCaptureRuntimePlan`); `wait` contributes no plan of its own, and its preferred
 * `findText` rides that plan's preferred set beside `get`'s `readTextAtPoint`.
 */
export function waitObservesDevice(target: WaitRuntimeTarget): boolean {
  return target !== 'sleep';
}
