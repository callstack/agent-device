import type { DaemonBinding } from '@agent-device/contracts/client';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonInfo } from './daemon-client-metadata.ts';
import { daemonIdentityOf } from './daemon-lifecycle-errors.ts';

/** Refuses a pin without exposing either instance's credential. */
export function daemonBindingMismatchError(
  binding: DaemonBinding,
  registered: DaemonInfo | null,
  stateDir: string,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'The registered daemon does not match this client instance.',
    {
      reason: 'daemon-binding-mismatch',
      stateDir,
      bound: { pid: binding.pid, processStartTime: binding.processStartTime },
      ...(registered ? { registered: daemonIdentityOf(registered) } : {}),
      hint: `Check ${shellQuoteIfNeeded(`${stateDir}/daemon.json`)} or obtain clientConfig from a running host. A pinned client never starts or replaces a daemon.`,
    },
  );
}
