import type {
  MaestroRuntimePort,
  MaestroRuntimeRequest,
  MaestroRuntimeResult,
} from './engine-types.ts';
import { executeMaestroRuntimeCommand } from './runtime-port-commands.ts';
import { observeMaestroCondition } from './runtime-port-observation.ts';
import type { MaestroRuntimeOperations } from './runtime-port-types.ts';

export type { MaestroRuntimePort } from './engine-types.ts';
export type {
  MaestroInputTarget,
  MaestroRuntimeOperationContext,
  MaestroRuntimeReadContext,
  MaestroRuntimeOperationResult,
  MaestroRuntimeOperations,
  MaestroSelectorEvidence,
  MaestroSwipeOperation,
  MaestroTargetMatch,
  MaestroTargetQuery,
  MaestroTargetResolution,
} from './runtime-port-types.ts';

export function createMaestroRuntimePort(operations: MaestroRuntimeOperations): MaestroRuntimePort {
  return {
    execute: async (request: MaestroRuntimeRequest): Promise<MaestroRuntimeResult> =>
      await executeMaestroRuntimeCommand(request, operations),
    observe: async (request) => await observeMaestroCondition(request, operations),
  };
}
