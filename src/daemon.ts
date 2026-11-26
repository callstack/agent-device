import { asAppError } from '@agent-device/kernel/errors';
import { daemonStartupExitCode, reportDaemonClose, startDaemonRuntime } from '@agent-device/daemon';
import { openDaemonStartupProgress } from '@agent-device/daemon-contracts/daemon-startup-phases';

// The executable owns the process: signals, fatal-error handlers and the exit code. The runtime
// only reports when it has closed, whoever closed it.
// The root's composition enters as a factory behind a function-scoped `await import`: the server
// loads it after acquiring registration for a hosted attachment. The import keeps the eager
// closure of this entry on the operational server (ADR 0019).
async function runDaemon(): Promise<void> {
  const { captureHostEnvironment } = await import('@agent-device/host-kit/environment');
  const host = captureHostEnvironment(process);
  const startupProgress = openDaemonStartupProgress(host.env, process);
  startupProgress.report('modules-loaded');
  const runtime = await startDaemonRuntime({
    host,
    startupProgress,
    bindAttachment:
      host.env.AGENT_DEVICE_HOSTED_ATTACHMENT === undefined
        ? undefined
        : async (stateDir) =>
            (await import('./cli/connection/cloud-attachment.ts')).bindHostedDaemon(host, stateDir),
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
