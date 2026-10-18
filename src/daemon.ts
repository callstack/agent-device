import { asAppError, normalizeError } from '@agent-device/kernel/errors';
import { startDaemonRuntime } from '@agent-device/daemon';
import {
  claimDaemonStartupPhasesFile,
  recordDaemonStartupMarker,
  resolveDaemonStartupPhasesPath,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

// Marker failures go to stderr, which the launcher redirects into the daemon log; a refused
// append is evidence, never a startup requirement.
function reportMarkerFailure(error: unknown): void {
  process.stderr.write(`Daemon startup marker write failed: ${normalizeError(error).message}\n`);
}

const ownPhasesPath = resolveDaemonStartupPhasesPath(
  resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR).baseDir,
  process.pid,
);
// The claim first: after pid reuse it is the only defense against reading a dead lifetime's
// phases as this launch's own.
claimDaemonStartupPhasesFile(ownPhasesPath, reportMarkerFailure);
recordDaemonStartupMarker(ownPhasesPath, 'modules-loaded', reportMarkerFailure);

// The composition enters as a factory behind a function-scoped `await import`, keeping startup
// order and this entry's eager closure exactly the operational server's (ADR 0019).
void startDaemonRuntime({
  composeDeps: async (input) => {
    const deps = await (await import('./daemon-composition.ts')).createDaemonRuntimeDeps(input);
    recordDaemonStartupMarker(
      resolveDaemonStartupPhasesPath(input.baseDir, process.pid),
      'composition-loaded',
      reportMarkerFailure,
    );
    return deps;
  },
}).catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
