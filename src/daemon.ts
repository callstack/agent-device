import { asAppError } from '@agent-device/kernel/errors';
import { startDaemonRuntime } from '@agent-device/daemon/server/daemon-runtime';

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
