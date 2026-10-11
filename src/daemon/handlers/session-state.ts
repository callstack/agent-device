import type { DaemonResponse } from '../daemon-request.ts';
import type { RuntimeCommandHandlerParams } from '../session-runtime-admission.ts';
import { handleAppStateCommand } from './session-appstate.ts';
import { handleBootCommand } from './session-boot.ts';
import { handleShutdownCommand } from './session-shutdown.ts';

/**
 * The routing card for the device-state command group. Each of `boot`, `shutdown` and `appstate`
 * answers its own domain question in a dedicated handler; this entry only decides which handler
 * speaks, and returns null for a command the group does not own.
 */
export async function handleSessionStateCommands(
  params: RuntimeCommandHandlerParams,
): Promise<DaemonResponse | null> {
  if (params.req.command === 'boot') return await handleBootCommand(params);
  if (params.req.command === 'shutdown') return await handleShutdownCommand(params);
  if (params.req.command === 'appstate') return await handleAppStateCommand(params);
  return null;
}
