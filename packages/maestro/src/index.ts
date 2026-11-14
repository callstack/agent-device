export {
  collectMaestroFailureSuggestions,
  executeMaestroFlow,
  inspectMaestroFlow,
  type MaestroActionEvent,
  type MaestroCompletedActionEvent,
  type MaestroExecutionObserver,
  type MaestroExecutionOutcome,
  type MaestroFailedAction,
  type MaestroFlow,
} from './internal/facade-execution.ts';

export type { MaestroSourceReader } from './internal/program-loader.ts';

export { collectMaestroFlowSources } from './internal/source-closure.ts';

export { exportReplayActionsToMaestro } from './internal/export-flow.ts';

export { MAESTRO_SELECTOR_PROJECTION } from './internal/selector-vocabulary.ts';

export {
  createMaestroRuntimePort,
  literalFromMaestroRegex,
  maestroObservationMatches,
  maestroTestFailure,
  MAESTRO_RUNTIME_ADAPTER_POLICY,
  resolveMaestroScrollableGesture,
  resolveMaestroTargetFromSnapshot,
  hasMaestroRecursiveRelations,
  type MaestroDispatchSelector,
  type MaestroObservation,
  type MaestroObservationCondition,
  type MaestroObservationIdentity,
  type MaestroPlatform,
  type MaestroRuntimeMetrics,
  type MaestroRuntimeCommand,
  type MaestroRuntimeOperationContext,
  type MaestroRuntimeOperations,
  type MaestroRuntimePort,
  type MaestroRuntimeReadContext,
  type MaestroSelector,
  type MaestroSinglePointerGestureInput,
  type MaestroSnapshotTargetQuery,
  type MaestroTargetMatch,
  type MaestroTargetQuery,
} from './internal/facade-runtime-port.ts';
