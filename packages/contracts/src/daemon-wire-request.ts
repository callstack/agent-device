import type { CommandFlags } from './command-flags.ts';
import type {
  DaemonInstallSource,
  LeaseBackend,
  DaemonRequestMeta as PublicDaemonRequestMeta,
  DaemonRequest as WireRequest,
} from '@agent-device/kernel/contracts';
import type { PlatformSelector } from '@agent-device/kernel/device';

/**
 * Request metadata as a client may send it, with the two fields the daemon narrows past what the
 * wire can express and the lease coordinates the router reads. Public throughout: nothing here
 * names live session state.
 */
export type DaemonWireRequestMeta = Omit<
  PublicDaemonRequestMeta,
  'installSource' | 'lockPlatform'
> & {
  installSource?: DaemonInstallSource;
  lockPlatform?: PlatformSelector;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
};

/**
 * A dispatched request with nothing daemon-private in it: `token` and `session` are required as
 * they are by dispatch time, and `flags` is narrowed to the `CommandFlags` vocabulary the wire
 * cannot enforce. There is no `internal` key and no property path to the daemon's live session
 * record or its admitted lease, which is what lets a package read a request — its command, flags
 * and public metadata — and build the next one to dispatch. The daemon's `daemon-request.ts`
 * adds the daemon-only half on top of this shape; a zone that only needs to classify a command
 * takes `DispatchedCommand` instead.
 */
export type DaemonWireRequest = Omit<WireRequest, 'token' | 'session' | 'flags' | 'meta'> & {
  token: string;
  session: string;
  flags?: CommandFlags;
  meta?: DaemonWireRequestMeta;
};
