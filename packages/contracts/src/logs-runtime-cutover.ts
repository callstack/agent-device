import {
  assertCommandPlatformExecution,
  type CommandPlatformExecution,
} from './command-platform-execution.ts';
import { appLogRuntimePlanUses } from './logs-runtime-plan.ts';
import type { RuntimeUseDeclaration } from './platform-runtime.ts';

/** Joins the input-dependent logs plans to one exhaustive descriptor declaration. */
export function assertLogsRuntimeExecution(
  value: unknown,
): asserts value is Extract<CommandPlatformExecution, { kind: 'device-runtime'; uses: unknown }> {
  assertCommandPlatformExecution(value);
  if (value.kind !== 'device-runtime' || !('uses' in value)) throw invalidLogsExecution();
  const declared = new Set(value.uses.map(runtimeUseIdentity));
  const planned = new Set(appLogRuntimePlanUses.map(runtimeUseIdentity));
  if (declared.size !== planned.size || [...declared].some((identity) => !planned.has(identity))) {
    throw invalidLogsExecution();
  }
}

function runtimeUseIdentity(use: RuntimeUseDeclaration): string {
  return JSON.stringify({
    required: [...use.required].sort(),
    preferred: [...use.preferred].sort(),
  });
}

function invalidLogsExecution(): TypeError {
  return new TypeError(
    'Logs runtime execution must declare exactly the distinct uses selected by its seven plans',
  );
}
