import type { RuntimeUseStep } from '@agent-device/contracts/command-platform-execution';
import {
  isRuntimeOperationName,
  type RuntimeOperationName,
} from '@agent-device/contracts/runtime-operation-names';
import { commandDescriptors } from './registry.ts';
import type { CommandDescriptor } from './types.ts';

const descriptorsByName = new Map<string, CommandDescriptor>(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor]),
);

/** One step of a plan as the batch runner holds it: the command plus what its handler will read. */
export type PlannedStep = RuntimeUseStep & Readonly<{ command: string }>;

export type PlannedRuntimeOperation = RuntimeOperationName;

/**
 * The runtime operations a sequence of steps must execute, read from each command's declared
 * platform execution (ADR 0019 §6). Only `required` operations count: a preferred or conditional
 * operation is a measured fast path the command succeeds without, so it must not pull a runner
 * into a plan that is otherwise observation-only. A command whose alternatives differ selects
 * them from the step the way its handler does (`selectUses`); every other command contributes
 * all of its alternatives. Returns `undefined` when any command is unknown to the registry: an
 * unregistered step makes the plan unproven rather than silently empty.
 */
export function resolvePlannedRuntimeOperations(
  steps: readonly PlannedStep[],
): readonly PlannedRuntimeOperation[] | undefined {
  const operations = new Set<PlannedRuntimeOperation>();
  for (const step of steps) {
    const descriptor = descriptorsByName.get(step.command);
    if (!descriptor) return undefined;
    const execution = descriptor.platformExecution;
    if (execution.kind !== 'device-runtime') continue;
    const uses =
      'uses' in execution ? (execution.selectUses?.(step) ?? execution.uses) : [execution.use];
    for (const use of uses) {
      for (const operation of use.required) {
        // `defineUse` admits only operation keys, so an unknown name means the vocabulary list
        // and the operations union drifted; treat the plan as unproven rather than guess.
        if (!isRuntimeOperationName(operation)) return undefined;
        operations.add(operation);
      }
    }
  }
  return Object.freeze([...operations].sort());
}
