export {
  countDiagnosticEventsByPhase,
  createRequestId,
  type DiagnosticEventInput,
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  getDiagnosticsMeta,
  registerDiagnosticSensitiveValue,
  updateDiagnosticsScope,
  withDiagnosticsScope,
  withDiagnosticTimer,
} from './internal/diagnostics.ts';
