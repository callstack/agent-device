import type { RuntimeFacts, RuntimeOperationFact } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import type { RuntimeUseStep } from '@agent-device/contracts/command-platform-execution';
import {
  isRuntimeOperationName,
  type RuntimeOperationName,
} from '@agent-device/contracts/runtime-operation-names';
import { commandRuntimeUseRequirements, commandDescriptors } from './registry.ts';
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
    const required = requiredOperationsOf(step);
    if (required === undefined) return undefined;
    for (const operation of required) operations.add(operation);
  }
  return Object.freeze([...operations].sort());
}

/** One step's required operations, or `undefined` when the step cannot be planned honestly. */
function requiredOperationsOf(step: PlannedStep): readonly PlannedRuntimeOperation[] | undefined {
  const execution = descriptorsByName.get(step.command)?.platformExecution;
  if (execution === undefined) return undefined;
  if (execution.kind !== 'device-runtime') return [];
  const uses =
    'uses' in execution ? (execution.selectUses?.(step) ?? execution.uses) : [execution.use];
  const required = uses.flatMap((use) => use.required);
  // `defineUse` admits only operation keys, so an unknown name means the vocabulary list and the
  // operations union drifted; treat the plan as unproven rather than guess.
  return required.every(isRuntimeOperationName) ? required : undefined;
}

/**
 * The one answer to "can this device run this command," read from the device's
 * runtime facts. The `capabilities` inventory and every offline reader of those
 * facts (the capabilities-page generator) decide through here, so a generated
 * page and a live session cannot disagree about the same device.
 *
 * One fully admitted use is enough, because a request names exactly one action.
 * An empty `required` set is not one admitted use: `[].every` is vacuously true,
 * and a plan that needs no operation must not read as proof that the device can
 * run the command. Descriptor execution metadata is structurally validated as
 * string arrays, not as keys of the concrete facts catalog, so an operation the
 * inspected owner does not state keeps the projection fail-closed instead of
 * throwing out of the whole response. A command that is no device-runtime
 * command, and a device that states no facts, are never available.
 */
export function commandIsAvailableFromFacts(
  command: string,
  facts: RuntimeFacts<PlatformRuntimeOperations> | undefined,
): boolean {
  const declaredUses = commandRuntimeUseRequirements(command);
  if (!declaredUses || !facts) return false;
  return declaredUses.some(
    (required) =>
      required.length > 0 && required.every((operation) => hasAvailableFact(facts, operation)),
  );
}

function hasAvailableFact(
  facts: RuntimeFacts<PlatformRuntimeOperations>,
  operation: string,
): boolean {
  if (!Object.hasOwn(facts.operations, operation)) return false;
  return (
    (facts.operations as Readonly<Record<string, RuntimeOperationFact>>)[operation]?.available ===
    true
  );
}
