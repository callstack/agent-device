export {
  countDiagnosticEventsByPhase,
  createRequestId,
  DIAGNOSTIC_STDERR_PREFIX,
  type DiagnosticEventInput,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  registerDiagnosticSensitiveValue,
  type ResourceDiagnostic,
  updateDiagnosticsScope,
  withDiagnosticsScope,
  withDiagnosticTimer,
} from './internal/diagnostics.ts';
