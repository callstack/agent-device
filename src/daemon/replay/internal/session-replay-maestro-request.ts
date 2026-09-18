import type { MaestroDaemonOperationRequest } from '@agent-device/maestro/daemon-runtime-port';
import { stripUndefined } from '@agent-device/kernel/record';
import type { ReplayDispatchRequest } from './command-types.ts';

/**
 * The daemon half of the Maestro runtime port. The port projects a flow step onto one public
 * command plus the dispatch options it needs honored; this keeps the replay request's own
 * envelope (token, session, metadata, runtime hints), replaces the command it carried, and folds
 * those options into the dispatch bag the daemon turns into request-private state.
 */
export function maestroOperationDispatchRequest(
  replay: ReplayDispatchRequest,
  operation: MaestroDaemonOperationRequest,
): ReplayDispatchRequest {
  const dispatch = stripUndefined({
    ...replay.dispatch,
    ...operation.dispatch,
  });
  return stripUndefined({
    ...replay,
    command: operation.command,
    positionals: operation.positionals,
    input: operation.input,
    flags: operation.flags,
    dispatch: Object.keys(dispatch).length > 0 ? dispatch : undefined,
  });
}
