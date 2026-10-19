import {
  connectCommand as connectCommandOnHost,
  connectionCommand as connectionCommandOnHost,
  disconnectCommand as disconnectCommandOnHost,
} from '../../cli/commands/connection.ts';
import { materializeRemoteConnectionForCommand as materializeRemoteConnectionForCommandOnHost } from '../../cli/commands/connection-runtime.ts';
import { tryRunClientBackedCommand as tryRunClientBackedCommandOnHost } from '../../cli/commands/router.ts';
import { withTestHost } from './with-test-host.ts';

/** The CLI commands that take a run's host, bound to a fresh test host. */
export const connectCommand = withTestHost(connectCommandOnHost);
export const disconnectCommand = withTestHost(disconnectCommandOnHost);
export const connectionCommand = withTestHost(connectionCommandOnHost);
export const materializeRemoteConnectionForCommand = withTestHost(
  materializeRemoteConnectionForCommandOnHost,
);
export const tryRunClientBackedCommand = withTestHost(tryRunClientBackedCommandOnHost);
