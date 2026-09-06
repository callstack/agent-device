import type { CommandFlags } from '@agent-device/contracts/command';
import type {
  LeaseBackend,
  DaemonInstallSource as PublicDaemonInstallSource,
  DaemonRequestMeta as PublicDaemonRequestMeta,
  DaemonRequest as WireRequest,
} from '@agent-device/kernel/contracts';
import type { PlatformSelector } from '@agent-device/kernel/device';

export type DaemonInstallSource = PublicDaemonInstallSource;

/**
 * Request metadata as a client may send it, with the two fields the daemon narrows past what the
 * wire can express and the lease coordinates the router reads. Public throughout: nothing here
 * names live session state.
 */
type DaemonRequestMeta = Omit<PublicDaemonRequestMeta, 'installSource' | 'lockPlatform'> & {
  installSource?: DaemonInstallSource;
  lockPlatform?: PlatformSelector;
  leaseBackend?: LeaseBackend;
  leaseProvider?: string;
};

/**
 * A dispatched request with nothing daemon-private in it: `token` and `session` are required as
 * they are by dispatch time, and `flags` is narrowed to the `CommandFlags` vocabulary the wire
 * cannot enforce. There is no `internal` key and no property path to `SessionState` or
 * `DeviceLease`, which is what lets a consumer read a request — its command, flags and public
 * metadata — without depending on the daemon's live session record. `daemon-request.ts` adds the
 * daemon-only half on top of this shape; a zone that only needs to classify a command takes
 * `contracts/dispatched-command.ts` instead.
 */
export type DaemonWireRequest = Omit<WireRequest, 'token' | 'session' | 'flags' | 'meta'> & {
  token: string;
  session: string;
  flags?: CommandFlags;
  meta?: DaemonRequestMeta;
};
