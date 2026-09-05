import { commandDescriptors } from './registry.ts';
import type { CommandDescriptor } from './types.ts';

const descriptorsByName = new Map<string, CommandDescriptor>(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor]),
);

/** One step of a plan as the batch runner knows it: the command and its structured input. */
export type PlannedStep = Readonly<{
  command: string;
  input?: Readonly<Record<string, unknown>>;
}>;

/**
 * The runtime operations a sequence of steps may execute, read from each command's declared
 * platform execution (ADR 0019 §6). A command whose alternatives differ selects them from the
 * step input the way its handler does (`selectUses`); every other command contributes all of its
 * alternatives, and every declared category counts — required, preferred, and conditional —
 * because a plan is proven observation-only only when no step can reach an interaction
 * operation. Returns `undefined` when any command is unknown to the registry: an unregistered
 * step makes the plan unproven rather than silently empty.
 */
export function resolvePlannedRuntimeOperations(
  steps: readonly PlannedStep[],
): readonly string[] | undefined {
  const operations = new Set<string>();
  for (const step of steps) {
    const descriptor = descriptorsByName.get(step.command);
    if (!descriptor) return undefined;
    const execution = descriptor.platformExecution;
    if (execution.kind !== 'device-runtime') continue;
    const uses =
      'uses' in execution
        ? (execution.selectUses?.(step.input) ?? execution.uses)
        : [execution.use];
    for (const use of uses) {
      for (const operation of [...use.required, ...use.preferred, ...(use.conditional ?? [])]) {
        operations.add(operation);
      }
    }
  }
  return Object.freeze([...operations].sort());
}
