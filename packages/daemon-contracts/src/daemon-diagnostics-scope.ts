import fs from 'node:fs';
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
 *
 * The log is a state record, so it is used as a sink only while the state rule accepts it. When it does not —
 * a link, a FIFO, or ground another local user controls — the scope runs WITHOUT a log path, and host-kit's
 * diagnostics owner sends each event to this process's stderr instead. That is the same answer a launch gets
 * when the log open is refused: the report leaves by a route no entry in the refused directory can steer, and
 * the daemon's work goes on.
 */
export async function withDaemonDiagnosticsScope<T>(
  options: DaemonDiagnosticsScopeOptions,
  body: () => Promise<T> | T,
): Promise<T> {
  const { command = 'daemon', debug = true } = options;
  const logPath = await verifiedDaemonLogSink(options.logPath);
  return await withDiagnosticsScope({ command, session: 'daemon', logPath, debug }, async () => {
    try {
      return await body();
    } finally {
      flushDiagnosticsToSessionFile({ force: true });
    }
  });
}

/**
 * Whether this process may append to `logPath` as a state record, or `undefined` when it may not.
 *
 * One attempted verified open decides it, asked every time a scope opens: a verdict kept for the life of the
 * process would outlive the ground it was judged on, and the events themselves are appended by NAME by
 * host-kit's diagnostics owner, so the only thing holding that name to the boundary is this judgment being
 * recent. The handle is closed at once — this is a verdict, not a handle. A refusal is said on stderr, on the
 * judgment and not on the refused name, because a FIFO or a link planted there would stop or steer the very
 * report about it.
 *
 * The state rule is loaded on first use, and not at import: this module is in the daemon's eager closure, and
 * host-kit's file surface is not, so a static edge here would put every state opener in front of every daemon
 * start.
 */
async function verifiedDaemonLogSink(logPath: string): Promise<string | undefined> {
  const { tryOpenPrivateStateFileSync } = await import('@agent-device/host-kit/file');
  const opened = tryOpenPrivateStateFileSync(logPath, 'append');
  if (opened.descriptor === undefined) {
    // The refusal's own message, read without pulling kernel's error owner into this module's eager closure.
    sayOnStderr(`Daemon daemon_log_sink_refused: ${logPath}: ${String(opened.failure)}`);
    return undefined;
  }
  try {
    fs.closeSync(opened.descriptor);
  } catch {
    // The verdict is all this handle was for.
  }
  return logPath;
}

function sayOnStderr(line: string): void {
  try {
    process.stderr.write(`${line}\n`);
  } catch {
    // No sink left to say it with; the events themselves still go to stderr.
  }
}
