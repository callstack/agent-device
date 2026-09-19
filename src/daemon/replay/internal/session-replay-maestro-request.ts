import type {
  MaestroDaemonDispatchOptions,
  MaestroDaemonOperationRequest,
} from '@agent-device/maestro/daemon-runtime-port';
import { stripUndefined } from '@agent-device/kernel/record';
import type { DaemonRequest } from '../../daemon-request.ts';

type DaemonRequestInternal = NonNullable<DaemonRequest['internal']>;

/**
 * The daemon half of the Maestro runtime port. The port projects a flow step onto one public
 * command plus the dispatch options it needs honored; this keeps the replay request's own
 * envelope (token, session, metadata, runtime hints, request-private state), replaces the command
 * it carried, and folds those options into `internal`, the one key the transport never accepts
 * from a client.
 */
export function maestroOperationDaemonRequest(
  replay: DaemonRequest,
  operation: MaestroDaemonOperationRequest,
): DaemonRequest {
  const internal = stripUndefined({
    ...replay.internal,
    ...dispatchInternal(operation.dispatch),
  });
  return stripUndefined({
    ...replay,
    command: operation.command,
    positionals: operation.positionals,
    input: operation.input,
    flags: operation.flags,
    internal: Object.keys(internal).length > 0 ? internal : undefined,
  });
}

/**
 * Every dispatch option the port may set, named against the daemon's own field. A key the port
 * adds without a daemon counterpart fails here, as does a daemon field the mapping forgets.
 */
function dispatchInternal(
  dispatch: MaestroDaemonDispatchOptions | undefined,
): Pick<DaemonRequestInternal, keyof MaestroDaemonDispatchOptions> {
  return stripUndefined({
    closeAppOnly: dispatch?.closeAppOnly,
    observationOnly: dispatch?.observationOnly,
    gestureViewport: dispatch?.gestureViewport,
    gestureExecutionProfile: dispatch?.gestureExecutionProfile,
    settingsAppBundleId: dispatch?.settingsAppBundleId,
  } satisfies Record<keyof MaestroDaemonDispatchOptions, unknown>);
}
