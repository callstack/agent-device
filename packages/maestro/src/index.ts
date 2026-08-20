export {
  collectMaestroFailureSuggestions,
  executeMaestroFlow,
  inspectMaestroFlow,
  type MaestroActionEvent,
  type MaestroCompletedActionEvent,
  type MaestroExecutionObserver,
  type MaestroExecutionOptions,
  type MaestroExecutionOutcome,
  type MaestroFailedAction,
  type MaestroFlow,
} from './internal/facade-execution.ts';

export type { MaestroSourceReader } from './internal/program-loader.ts';

export {
  collectMaestroFlowSources,
  type MaestroOptionalSourceReader,
} from './internal/source-closure.ts';

export {
  exportReplayActionsToMaestro,
  MAESTRO_SELECTOR_PROJECTION,
  type MaestroExportOptions,
  type MaestroExportResult,
  type MaestroExportWarning,
  type MaestroSelectorProjection,
} from './internal/facade-export.ts';

export {
  formatMaestroCompatibilityReference,
  MAESTRO_COMPATIBILITY_ADR_URL,
  MAESTRO_COMPATIBILITY_ISSUE_URL,
  MAESTRO_COMPAT_LIMITATIONS,
  MAESTRO_COMPAT_SUPPORTED_CAPABILITIES,
} from './internal/facade-support.ts';

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
  type MaestroRuntimeOperationResult,
  type MaestroRuntimeOperations,
  type MaestroRuntimePort,
  type MaestroRuntimePortLifecycle,
  type MaestroRuntimeReadContext,
  type MaestroSelector,
  type MaestroSinglePointerGestureInput,
  type MaestroSnapshotTargetQuery,
  type MaestroTargetMatch,
  type MaestroTargetQuery,
  type MaestroTargetResolution,
} from './internal/facade-runtime-port.ts';
