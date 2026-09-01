export {
  countDiagnosticEventsByPhase,
  createRequestId,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  registerDiagnosticSensitiveValue,
  updateDiagnosticsScope,
  withDiagnosticsScope,
  withDiagnosticTimer,
} from './internal/diagnostics.ts';
