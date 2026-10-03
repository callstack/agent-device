export {
  countDiagnosticEventsByPhase,
  createRequestId,
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
