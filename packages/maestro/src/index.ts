import {
  canonicalizeUpstreamFlow,
  canonicalizeAgentCommands,
  type CanonicalCommand,
} from './internal/conformance-normalize.ts';
import { maestroTestFailure } from './internal/compatibility-errors.ts';
import {
  MAESTRO_COMPATIBILITY_PRESETS,
  MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
} from './internal/compatibility-policy.ts';
import {
  type MaestroObservation,
  type MaestroObservationCondition,
  type MaestroObservationIdentity,
  type MaestroRuntimeMetrics,
  type MaestroRuntimePort,
  type MaestroRuntimeCommand,
} from './internal/engine-types.ts';
import {
  exportReplayActionsToMaestro,
  type MaestroExportOptions,
  type MaestroExportResult,
  type MaestroExportWarning,
} from './internal/export-flow.ts';
import { parseMaestroProgram } from './internal/program-ir-parser.ts';
import { SUPPORTED_MAESTRO_COMMAND_NAMES } from './internal/program-ir-command-parser.ts';
import type { MaestroPlatform, MaestroSelector } from './internal/program-ir.ts';
import {
  executeMaestroRuntimeCommand,
  maestroCommandRequiresSettledPredecessor,
} from './internal/runtime-port-commands.ts';
import { operationContext } from './internal/runtime-port-context.ts';
import {
  maestroObservationMatches,
  observeMaestroCondition,
} from './internal/runtime-port-observation.ts';
import type {
  MaestroDispatchSelector,
  MaestroRuntimeOperationContext,
  MaestroRuntimeOperationResult,
  MaestroRuntimeReadContext,
  MaestroRuntimeOperations,
  MaestroSinglePointerGestureInput,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './internal/runtime-port-types.ts';
import { resolveMaestroScrollableGesture } from './internal/runtime-port-geometry.ts';
import { literalFromMaestroRegex } from './internal/selector-regex.ts';
import { resolveMaestroTargetFromSnapshot } from './internal/runtime-targets.ts';
import type {
  MaestroTargetQuery as MaestroSnapshotTargetQuery,
  MaestroTargetResolution,
} from './internal/runtime-targets.ts';
import {
  formatMaestroCompatibilityReference,
  MAESTRO_COMPAT_LIMITATIONS,
  MAESTRO_COMPAT_SUPPORTED_CAPABILITIES,
  MAESTRO_COMPATIBILITY_ADR_URL,
  MAESTRO_COMPATIBILITY_ISSUE_URL,
} from './internal/support-matrix.ts';

export type MaestroRuntimePortLifecycle = {
  beforeExecute?(input: {
    context: MaestroRuntimeOperationContext;
    requiresSettledPredecessor: boolean;
    visualStabilityBarrier: boolean;
  }): Promise<void>;
  afterExecute?(input: {
    context: MaestroRuntimeOperationContext;
    visualStabilityReached: boolean;
  }): void;
  bindObservation?(
    observation: Awaited<ReturnType<MaestroRuntimePort['observe']>>,
  ): Awaited<ReturnType<MaestroRuntimePort['observe']>>;
  readMetrics?(): NonNullable<ReturnType<NonNullable<MaestroRuntimePort['readMetrics']>>>;
};

export type {
  CanonicalCommand as MaestroCanonicalCommand,
  MaestroDispatchSelector,
  MaestroExportOptions,
  MaestroExportResult,
  MaestroExportWarning,
  MaestroObservation,
  MaestroObservationCondition,
  MaestroObservationIdentity,
  MaestroPlatform,
  MaestroRuntimeMetrics,
  MaestroRuntimeCommand,
  MaestroRuntimeOperationContext,
  MaestroRuntimeOperationResult,
  MaestroRuntimeOperations,
  MaestroRuntimePort,
  MaestroRuntimeReadContext,
  MaestroSelector,
  MaestroSinglePointerGestureInput,
  MaestroSnapshotTargetQuery,
  MaestroTargetMatch,
  MaestroTargetQuery,
  MaestroTargetResolution,
};

export {
  executeMaestroFlow,
  inspectMaestroFlow,
  rankMaestroFailureCandidates,
  type MaestroActionEvent,
  type MaestroCompletedActionEvent,
  type MaestroExecutionObserver,
  type MaestroExecutionOptions,
  type MaestroExecutionOutcome,
  type MaestroFailedAction,
  type MaestroFailureCandidate,
  type MaestroFlow,
} from './internal/facade-execution.ts';

export {
  exportReplayActionsToMaestro,
  formatMaestroCompatibilityReference,
  literalFromMaestroRegex,
  maestroObservationMatches,
  maestroTestFailure,
  MAESTRO_COMPATIBILITY_PRESETS,
  MAESTRO_COMPATIBILITY_ADR_URL,
  MAESTRO_COMPATIBILITY_ISSUE_URL,
  MAESTRO_COMPAT_LIMITATIONS,
  MAESTRO_COMPAT_SUPPORTED_CAPABILITIES,
  MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
  resolveMaestroScrollableGesture,
  resolveMaestroTargetFromSnapshot,
  SUPPORTED_MAESTRO_COMMAND_NAMES,
};

export const MAESTRO_CONFORMANCE_CONSTANTS = {
  retryMaxRetries: MAESTRO_COMPATIBILITY_PRESETS.control.retryMaxRetries,
  animationWaitThreshold:
    MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndDifferencePercent,
  animationWaitTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndTimeoutMs,
  maxEraseCharacters: MAESTRO_COMPATIBILITY_PRESETS.command.eraseTextMaxCharacters,
  swipeDurationMs: MAESTRO_COMPATIBILITY_PRESETS.command.swipeDurationMs,
} as const;

export function parseMaestroConformanceSource(
  source: string,
  sourcePath: string,
): { commands: CanonicalCommand[]; kinds: Set<string> } {
  const program = parseMaestroProgram(source, { sourcePath });
  const kinds = new Set<string>();
  collectCommandKinds(program.commands, kinds);
  return { commands: canonicalizeAgentCommands(program), kinds };
}

export { canonicalizeUpstreamFlow as canonicalizeUpstreamMaestroFlow };

export function createMaestroRuntimePort(
  operations: MaestroRuntimeOperations,
  lifecycle: MaestroRuntimePortLifecycle = {},
): MaestroRuntimePort {
  return {
    execute: async (request) => {
      const context = operationContext(request, request.command);
      const visualStabilityBarrier = request.command.kind === 'waitForAnimationToEnd';
      await lifecycle.beforeExecute?.({
        context,
        requiresSettledPredecessor:
          maestroCommandRequiresSettledPredecessor(request.command) && !visualStabilityBarrier,
        visualStabilityBarrier,
      });
      const result = await executeMaestroRuntimeCommand(request, operations);
      lifecycle.afterExecute?.({
        context,
        visualStabilityReached: visualStabilityBarrier && result.visualStabilityReached === true,
      });
      delete result.visualStabilityReached;
      return result;
    },
    observe: async (request) => {
      const observation = await observeMaestroCondition(request, operations);
      return lifecycle.bindObservation?.(observation) ?? observation;
    },
    ...(lifecycle.readMetrics ? { readMetrics: lifecycle.readMetrics } : {}),
  };
}

function collectCommandKinds(
  commands: Array<{ kind: string; commands?: unknown }>,
  into: Set<string>,
): void {
  for (const command of commands) {
    into.add(command.kind);
    if (Array.isArray(command.commands)) {
      collectCommandKinds(command.commands as Array<{ kind: string; commands?: unknown }>, into);
    }
  }
}
