import {
  assertCommandPlatformExecution,
  type CommandPlatformExecution,
} from './command-platform-execution.ts';
import { screenRecordingRuntimePlanUses } from './screen-recording-runtime-plan.ts';
import { runtimeUseIdentity } from './platform-runtime-use.ts';

/** Joins every normalized record plan to the descriptor's exhaustive runtime declaration. */
export function assertRecordRuntimeExecution(
  value: unknown,
): asserts value is Extract<CommandPlatformExecution, { kind: 'device-runtime'; uses: unknown }> {
  assertCommandPlatformExecution(value);
  if (value.kind !== 'device-runtime' || !('uses' in value)) throw invalidRecordExecution();
  const declaredIdentities = value.uses.map(runtimeUseIdentity);
  const plannedIdentities = screenRecordingRuntimePlanUses.map(runtimeUseIdentity);
  const declared = new Set(declaredIdentities);
  const planned = new Set(plannedIdentities);
  if (
    declaredIdentities.length !== plannedIdentities.length ||
    declared.size !== declaredIdentities.length ||
    [...declared].some((identity) => !planned.has(identity))
  ) {
    throw invalidRecordExecution();
  }
}

function invalidRecordExecution(): TypeError {
  return new TypeError(
    'Record runtime execution must declare exactly the uses selected by its two runtime-bearing plans',
  );
}
