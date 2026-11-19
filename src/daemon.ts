import { asAppError } from '@agent-device/kernel/errors';
import { daemonStartupExitCode, reportDaemonClose, startDaemonRuntime } from '@agent-device/daemon';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import { reportDaemonStartupPhase } from '@agent-device/daemon-contracts/daemon-startup-phases';

// Captured once: the runtime resolves the state dir from this one host, so a relative
// AGENT_DEVICE_STATE_DIR cannot land the daemon beside another directory's lock.
const host = captureHostEnvironment(process);
// The earliest phase, reported to the launcher over the IPC channel it opened at spawn. Without a
// channel (embedded or manual start) this is a no-op.
reportDaemonStartupPhase('modules-loaded');

// The executable owns the process: signals, fatal-error handlers and the exit code. The runtime
// only reports when it has closed, whoever closed it.
// The root's composition enters as a factory behind a function-scoped `await import`: the server
// calls it before it acquires the registration, so startup order is unchanged, and the eager
// closure of this entry stays exactly the operational server's (ADR 0019).
async function runDaemon(): Promise<void> {
  const runtime = await startDaemonRuntime({
    host,
    composeDeps: async (input) => {
      const deps = await (await import('./daemon-composition.ts')).createDaemonRuntimeDeps(input);
      reportDaemonStartupPhase('composition-loaded');
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
