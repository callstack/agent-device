import { startDaemonRuntime } from './daemon/server/daemon-runtime.ts';
import { asAppError } from '@agent-device/kernel/errors';

void startDaemonRuntime({
  // This executable is the composition root that builds the daemon's command surface. The
  // loader stays behind `await import` (ADR 0019): the whole surface would otherwise join
  // src/daemon.ts's eager closure and undo the lazy generic-dispatch split.
  loadCommandSurface: async () =>
    (await import('./command-runtime/runtime-command-surface.ts')).createCommandSurfaceAgentDevice,
}).catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
