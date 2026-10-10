import { createCommandSurfaceAgentDevice } from './command-runtime/runtime-command-surface.ts';
import { startDaemonRuntime } from './daemon/server/daemon-runtime.ts';
import { asAppError } from '@agent-device/kernel/errors';

void startDaemonRuntime({
  // This executable is the composition root that builds the daemon's command surface.
  createCommandSurface: createCommandSurfaceAgentDevice,
}).catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
