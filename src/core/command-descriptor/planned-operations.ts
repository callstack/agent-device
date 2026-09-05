import { commandDescriptors } from './registry.ts';
import type { CommandDescriptor } from './types.ts';

const descriptorsByName = new Map<string, CommandDescriptor>(
  commandDescriptors.map((descriptor) => [descriptor.name, descriptor]),
);

/**
 * The runtime operations a sequence of commands may execute, read from each command's declared
 * platform execution (ADR 0019 §6). Every declared category counts — required, preferred, and
 * conditional — because a plan is proven observation-only only when no step can reach an
 * interaction operation. Returns `undefined` when any command is unknown to the registry: an
 * unregistered step makes the plan unproven rather than silently empty.
 */
export function resolvePlannedRuntimeOperations(
  commands: readonly string[],
): readonly string[] | undefined {
  const operations = new Set<string>();
  for (const command of commands) {
    const descriptor = descriptorsByName.get(command);
    if (!descriptor) return undefined;
    const execution = descriptor.platformExecution;
    if (execution.kind !== 'device-runtime') continue;
    const uses = 'uses' in execution ? execution.uses : [execution.use];
    for (const use of uses) {
      for (const operation of [...use.required, ...use.preferred, ...(use.conditional ?? [])]) {
        operations.add(operation);
      }
    }
  }
  return Object.freeze([...operations].sort());
}
