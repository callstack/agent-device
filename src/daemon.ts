import { startDaemonRuntime } from './daemon/server/daemon-runtime.ts';
import { asAppError } from '@agent-device/kernel/errors';

void startDaemonRuntime().catch((error) => {
  const appErr = asAppError(error);
  process.stderr.write(`Daemon error: ${appErr.message}\n`);
  process.exit(1);
});
