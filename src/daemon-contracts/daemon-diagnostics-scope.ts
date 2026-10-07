import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';

export type DaemonDiagnosticsScopeOptions = Readonly<{
  logPath: string;
  command?: 'daemon' | 'daemon-startup';
  debug?: boolean;
}>;

/**
 * Runs daemon-level work that has no request scope inside a `daemon` session scope, then forces its
 * events to `logPath`, also when the work throws. Without a scope `emitDiagnostic` drops every event.
 */
export async function withDaemonDiagnosticsScope<T>(
  options: DaemonDiagnosticsScopeOptions,
  body: () => Promise<T> | T,
): Promise<T> {
  const { logPath, command = 'daemon', debug = true } = options;
  return await withDiagnosticsScope({ command, session: 'daemon', logPath, debug }, async () => {
    try {
      return await body();
    } finally {
      flushDiagnosticsToSessionFile({ force: true });
    }
  });
}
