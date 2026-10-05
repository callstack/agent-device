import {
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';

export type DaemonDiagnosticsScopeOptions = Readonly<{
  logPath: string;
  command?: 'daemon' | 'daemon-startup';
  debug?: boolean;
  /** Also force the flush when `body` throws, so the record of a failure is kept. */
  flushOnThrow?: boolean;
}>;

/**
 * Runs daemon-level work that has no request scope inside a `daemon` session scope, then forces its
 * events to `logPath`. Without a scope `emitDiagnostic` drops every event.
 */
export async function withDaemonDiagnosticsScope<T>(
  options: DaemonDiagnosticsScopeOptions,
  body: () => Promise<T> | T,
): Promise<T> {
  const { logPath, command = 'daemon', debug = true, flushOnThrow = false } = options;
  return await withDiagnosticsScope({ command, session: 'daemon', logPath, debug }, async () => {
    if (!flushOnThrow) {
      const result = await body();
      flushDiagnosticsToSessionFile({ force: true });
      return result;
    }
    try {
      return await body();
    } finally {
      flushDiagnosticsToSessionFile({ force: true });
    }
  });
}
