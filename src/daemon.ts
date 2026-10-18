import { asAppError, normalizeError } from '@agent-device/kernel/errors';
import {
  daemonStartupExitCode,
  reportDaemonClose,
  startDaemonRuntime,
} from '@agent-device/daemon';
import { captureHostEnvironment } from '@agent-device/host-kit/process';
import {
  claimDaemonStartupPhasesFile,
  recordDaemonStartupMarker,
  resolveDaemonStartupPhasesPath,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

// Marker failures go to stderr, redirected into the daemon log; a refused append never stops a
// startup that can still register.
function reportMarkerFailure(error: unknown): void {
  process.stderr.write(`Daemon startup marker write failed: ${normalizeError(error).message}\n`);
}

const ownPhasesPath = resolveDaemonStartupPhasesPath(
  resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR).baseDir,
  process.pid,
);
// The claim first: after pid reuse it is the only defense against a dead lifetime's phases.
claimDaemonStartupPhasesFile(ownPhasesPath, reportMarkerFailure);
recordDaemonStartupMarker(ownPhasesPath, 'modules-loaded', reportMarkerFailure);

// The executable owns the process: signals, fatal-error handlers and the exit code. The runtime
// only reports when it has closed, whoever closed it.
// Composition enters as a factory behind `await import`: startup order is unchanged and this
// entry's eager closure stays the operational server's (ADR 0019). The factory records
// `composition-loaded` when that import and dep build finish.
async function runDaemon(): Promise<void> {
  const runtime = await startDaemonRuntime({
    host: captureHostEnvironment(process),
    composeDeps: async (input) => {
      const deps = await (await import('./daemon-composition.ts')).createDaemonRuntimeDeps(input);
      recordDaemonStartupMarker(
        resolveDaemonStartupPhasesPath(input.baseDir, process.pid),
        'composition-loaded',
        reportMarkerFailure,
      );
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
