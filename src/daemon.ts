import { asAppError } from '@agent-device/kernel/errors';
import { daemonStartupExitCode, reportDaemonClose, startDaemonRuntime } from '@agent-device/daemon';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import {
  DAEMON_PROGRESS_CHANNEL_ENV,
  daemonStartupProgressMessage,
  type DaemonStartupProgress,
} from '@agent-device/daemon-contracts/daemon-startup-phases';

// Captured once: the runtime resolves the state dir from this one host, so a relative
// AGENT_DEVICE_STATE_DIR cannot land the daemon beside another directory's lock.
const host = captureHostEnvironment(process);
const startupProgress = openStartupProgressChannel();
startupProgress.report('modules-loaded');

/**
 * The launch channel the launcher opened at spawn. Without its mark or a channel (a manual start),
 * reporting is a no-op. The channel is unref'd so it never holds the daemon alive, and a failed
 * send (launcher gone) writes one stderr line: the callback form keeps it out of the
 * uncaughtException handler, which would otherwise end the daemon.
 */
function openStartupProgressChannel(): DaemonStartupProgress {
  const send = process.send?.bind(process);
  if (host.env[DAEMON_PROGRESS_CHANNEL_ENV] !== '1' || !process.channel || !send) {
    return { report() {}, close() {} };
  }
  process.channel.unref();
  let failed = false;
  return {
    report(phase) {
      if (failed || !process.connected) return;
      send(daemonStartupProgressMessage(phase), (error: Error | null) => {
        if (!error || failed) return;
        failed = true;
        process.stderr.write(`Daemon startup phase report failed: ${error.message}\n`);
      });
    },
    close() {
      if (process.connected) process.disconnect();
    },
  };
}

// The executable owns the process: signals, fatal-error handlers and the exit code. The runtime
// only reports when it has closed, whoever closed it.
// The root's composition enters as a factory behind a function-scoped `await import`: the server
// calls it before it acquires the registration, so startup order is unchanged, and the eager
// closure of this entry stays exactly the operational server's (ADR 0019).
async function runDaemon(): Promise<void> {
  const runtime = await startDaemonRuntime({
    host,
    startupProgress,
    composeDeps: async (input) => {
      const deps = await (await import('./daemon-composition.ts')).createDaemonRuntimeDeps(input);
      startupProgress.report('composition-loaded');
      return deps;
    },
  });
  let exitCode = 0;
  const closeAndExit = (code: number, cause?: unknown): void => {
    exitCode = Math.max(exitCode, code);
    // A failed close is reported once, through `closed` below.
    void runtime.close({ cause }).catch(() => {});
  };
  const failFatally = (error: unknown): void => {
    process.stderr.write(`Daemon error: ${asAppError(error).message}\n`);
    closeAndExit(1, error);
  };
  process.on('SIGINT', () => closeAndExit(0));
  process.on('SIGTERM', () => closeAndExit(0));
  process.on('SIGHUP', () => closeAndExit(0));
  process.on('uncaughtException', failFatally);
  process.on('unhandledRejection', (reason) =>
    failFatally(reason instanceof Error ? reason : new Error(String(reason))),
  );
  // Unfinished work is written for every close, whoever started it: a signal, the idle reap or a
  // quiesce. The registration may be held on purpose, and this is the only record of why.
  if ((await reportDaemonClose({ closed: runtime.closed, stderr: process.stderr })).failed) {
    exitCode = 1;
  }
  process.exit(exitCode);
}

runDaemon().catch((error) => {
  process.stderr.write(`Daemon error: ${asAppError(error).message}\n`);
  process.exit(daemonStartupExitCode(error));
});
