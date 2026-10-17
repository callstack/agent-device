import { asAppError } from '@agent-device/kernel/errors';
import { startDaemonRuntime } from '@agent-device/daemon';
import {
  recordDaemonStartupMarker,
  resolveDaemonStartupPhasesPath,
} from '@agent-device/daemon-contracts/daemon-registration-owner';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

// #3782: the first marker the waiting client can read. It says this entry's module graph evaluated,
// which on an overloaded host is the slowest thing a daemon start does before it can prove itself.
recordDaemonStartupMarker(
  resolveDaemonStartupPhasesPath(resolveDaemonPaths(process.env.AGENT_DEVICE_STATE_DIR).baseDir),
  'modules-loaded',
);

// The root's composition enters as a factory behind a function-scoped `await import`: the server
// calls it before it acquires the registration, so startup order is unchanged, and the eager
// closure of this entry stays exactly the operational server's (ADR 0019).
void startDaemonRuntime({
  composeDeps: async (input) =>
    (await import('./daemon-composition.ts')).createDaemonRuntimeDeps(input),
}).catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
