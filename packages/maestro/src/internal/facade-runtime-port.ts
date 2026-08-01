import { maestroTestFailure } from './compatibility-errors.ts';
import {
  MAESTRO_COMPATIBILITY_PRESETS,
  MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
} from './compatibility-policy.ts';
import type {
  MaestroObservation,
  MaestroObservationCondition,
  MaestroObservationIdentity,
  MaestroRuntimeMetrics,
  MaestroRuntimePort,
  MaestroRuntimeCommand,
} from './engine-types.ts';
import type { MaestroPlatform, MaestroSelector } from './program-ir.ts';
import {
  executeMaestroRuntimeCommand,
  maestroCommandRequiresSettledPredecessor,
} from './runtime-port-commands.ts';
import { operationContext } from './runtime-port-context.ts';
import { resolveMaestroScrollableGesture } from './runtime-port-geometry.ts';
import { maestroObservationMatches, observeMaestroCondition } from './runtime-port-observation.ts';
import type {
  MaestroDispatchSelector,
  MaestroRuntimeOperationContext,
  MaestroRuntimeOperationResult,
  MaestroRuntimeReadContext,
  MaestroRuntimeOperations,
  MaestroSinglePointerGestureInput,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './runtime-port-types.ts';
import { literalFromMaestroRegex } from './selector-regex.ts';
import {
  resolveMaestroTargetFromSnapshot,
  type MaestroTargetQuery as MaestroSnapshotTargetQuery,
  type MaestroTargetResolution,
} from './runtime-targets.ts';

/**
 * This is the complete policy vocabulary the daemon adapter must coordinate
 * with the engine. Keep the compatibility-policy tree private: adding a value
 * here requires a real adapter consumer and a decision-site explanation.
 */
export const MAESTRO_RUNTIME_ADAPTER_POLICY = {
  settleTimeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
  retryTapMaxAttempts: MAESTRO_COMPATIBILITY_PRESETS.command.retryTapMaxAttempts,
  longPressDurationMs: MAESTRO_COMPATIBILITY_PRESETS.command.longPressDurationMs,
  eraseTextMaxCharacters: MAESTRO_COMPATIBILITY_PRESETS.command.eraseTextMaxCharacters,
  scrollUntilVisiblePercentage: MAESTRO_COMPATIBILITY_PRESETS.command.scrollUntilVisiblePercentage,
  animationWaitTimeoutMs: MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndTimeoutMs,
  animationDifferencePercent:
    MAESTRO_COMPATIBILITY_PRESETS.command.waitForAnimationToEndDifferencePercent,
  observationPollMs: MAESTRO_COMPATIBILITY_PRESETS.observation.pollIntervalMs,
} as const;

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

/**
 * The daemon is the sole runtime adapter. These types describe only the port
 * values it must exchange with the engine; parser, plan, expression, and
 * ranking state deliberately remain absent from the package interface.
 */
export type {
  MaestroDispatchSelector,
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
  literalFromMaestroRegex,
  maestroObservationMatches,
  maestroTestFailure,
  resolveMaestroScrollableGesture,
  resolveMaestroTargetFromSnapshot,
};

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
