import type {
  MaestroDaemonDispatchOptions,
  MaestroDaemonOperationRequest,
} from '@agent-device/maestro/daemon-runtime-port';
import type { ReplayDispatchOptions } from '@agent-device/contracts/replay';
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
    ...maestroDispatchOptions(operation.dispatch),
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

/**
 * Every dispatch option the Maestro port may set, named against the replay dispatch key. A key
 * the port adds without a counterpart fails here, as does a key the mapping forgets.
 */
function maestroDispatchOptions(
  dispatch: MaestroDaemonDispatchOptions | undefined,
): Pick<ReplayDispatchOptions, keyof MaestroDaemonDispatchOptions> {
  return stripUndefined({
    closeAppOnly: dispatch?.closeAppOnly,
    killApp: dispatch?.killApp,
    observationOnly: dispatch?.observationOnly,
    gestureViewport: dispatch?.gestureViewport,
    gestureExecutionProfile: dispatch?.gestureExecutionProfile,
    settingsAppBundleId: dispatch?.settingsAppBundleId,
  } satisfies Record<keyof MaestroDaemonDispatchOptions, unknown>);
}
