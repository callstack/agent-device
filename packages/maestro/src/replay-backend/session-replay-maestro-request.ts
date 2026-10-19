import type {
  MaestroDaemonDispatchOptions,
  MaestroDaemonOperationRequest,
} from '../daemon-port/daemon-runtime-port.ts';
import type {
  ReplayBackendDispatchOptions,
  ReplayDispatchRequest,
} from '@agent-device/contracts/replay-backend';
import { stripUndefined } from '@agent-device/kernel/record';

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
): ReplayBackendDispatchOptions {
  return stripUndefined({
    closeAppOnly: dispatch?.closeAppOnly,
    killApp: dispatch?.killApp,
    observationOnly: dispatch?.observationOnly,
    gestureViewport: dispatch?.gestureViewport,
    gestureExecutionProfile: dispatch?.gestureExecutionProfile,
    settingsAppBundleId: dispatch?.settingsAppBundleId,
  } satisfies Record<keyof MaestroDaemonDispatchOptions, unknown>);
}
