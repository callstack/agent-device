import fs from 'node:fs';
import {
  type DiagnosticLineSink,
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';

/** The state owners this scope's sink needs, taken from host-kit's file surface. */
type PrivateStateOpenSurface = Readonly<{
  tryOpenPrivateStateFileSync: typeof import('@agent-device/host-kit/file').tryOpenPrivateStateFileSync;
  writePrivateStateLineSync: typeof import('@agent-device/host-kit/file').writePrivateStateLineSync;
}>;
export type DaemonDiagnosticsScopeOptions = Readonly<{
  logPath: string;
  command?: 'daemon' | 'daemon-startup';
  debug?: boolean;
}>;

/**
 * Runs daemon-level work that has no request scope inside a `daemon` session scope, then forces its
 * events to `logPath`, also when the work throws. Without a scope `emitDiagnostic` drops every event.
 *
 * The log is a state record, so its events reach it ONLY through a sink the state rule opened. host-kit's
 * diagnostics owner asks for that sink at the FIRST line and writes every line after it — the forced final
 * flush included — through the handle that judgment produced, and never at the name again. A scope that
 * emits nothing therefore opens nothing: no `daemon.log` appears and no mode is said, just because some
 * code opened a diagnostics scope.
 *
 * When the state rule refuses the path, the refusal is said once on this process's stderr and every event
 * leaves by stderr too — the same answer a launch gets when its log open is refused: the report travels by a
 * route no entry in the refused directory can steer or block, and the daemon's work goes on. A write that
 * breaks later costs one line to stderr and is re-judged at the next, so the sink can neither lose a run's
 * events nor stop a shutdown.
 */
export async function withDaemonDiagnosticsScope<T>(
  options: DaemonDiagnosticsScopeOptions,
  body: () => Promise<T> | T,
): Promise<T> {
  const { command = 'daemon', debug = true } = options;
  // The state owners, asked for here and not at import: this module is in the daemon's eager closure and
  // host-kit's file surface is not, so a static edge would put every state opener in front of every daemon
  // start. Loading the module opens nothing on disk; the file surface is only TOUCHED by the sink factory
  // below, which host-kit asks for at the first line.
  const state: PrivateStateOpenSurface = await import('@agent-device/host-kit/file');
  return await withDiagnosticsScope(
    {
      command,
      session: 'daemon',
      logPath: options.logPath,
      logSinkFactory: (logPath) => daemonLogSink(state, logPath),
      debug,
    },
    async () => {
      try {
        return await body();
      } finally {
        flushDaemonDiagnostics();
      }
    },
  );
}

/**
 * A diagnostics flush is an optional diagnostic: it costs a run its events and never the work being reported.
 */
function flushDaemonDiagnostics(): void {
  try {
    flushDiagnosticsToSessionFile({ force: true });
  } catch (error) {
    sayOnStderr(`Daemon daemon_log_flush_failed: ${String(error)}`);
  }
}

/**
 * The sink for one daemon log: a judged append handle, or stderr for the whole scope once the rule refused it.
 *
 * `write` answers whether the sink is still the route to use. A line that did not land is said on stderr —
 * an event is not allowed to die with a broken route — and the answer is `false`, so the owner drops this
 * sink and the next line asks for a fresh judgment rather than pushing bytes at a dead descriptor for the
 * rest of the run.
 */
function daemonLogSink(state: PrivateStateOpenSurface, logPath: string): DiagnosticLineSink {
  const opened = state.tryOpenPrivateStateFileSync(logPath, 'append');
  if (opened.descriptor === undefined) {
    // Said on the judgment and not on the refused name: a FIFO or a planted link there would stop or steer
    // the very report about it. The events themselves still leave by stderr.
    sayOnStderr(`Daemon daemon_log_sink_refused: ${logPath}: ${String(opened.failure)}`);
    return stderrSink();
  }
  const descriptor = opened.descriptor;
  let saidFailure = false;
  return {
    write: (line) => {
      try {
        state.writePrivateStateLineSync(descriptor, line);
        return true;
      } catch (error) {
        // The owner closes a sink whose write reported failure, so the descriptor is released there and
        // not twice here.
        if (!saidFailure) {
          saidFailure = true;
          sayOnStderr(`Daemon daemon_log_sink_failed: ${logPath}: ${String(error)}`);
        }
        writeLineToStderr(line);
        return false;
      }
    },
    close: () => tryClose(descriptor),
  };
}

function stderrSink(): DiagnosticLineSink {
  return {
    write: (line) => {
      writeLineToStderr(line);
      return true;
    },
    close: () => {},
  };
}

function writeLineToStderr(line: string): void {
  try {
    process.stderr.write(line);
  } catch {
    // No sink left to say it with.
  }
}

function sayOnStderr(line: string): void {
  writeLineToStderr(`${line}\n`);
}

function tryClose(descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } catch {
    // Nothing is left to do with a descriptor the host will not close.
  }
}
