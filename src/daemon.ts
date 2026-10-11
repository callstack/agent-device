import { startDaemonRuntime } from './daemon/server/daemon-runtime.ts';
import { asAppError } from '@agent-device/kernel/errors';

void startDaemonRuntime({
  // The composition root's surface stays behind `await import`, loaded on first request use.
  createCommandSurface: async (config) =>
    (await import('./command-runtime/runtime-command-surface.ts')).createCommandSurfaceAgentDevice(
      config,
    ),
}).catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
