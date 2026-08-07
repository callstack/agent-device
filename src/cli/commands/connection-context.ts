import crypto from 'node:crypto';
import type { CliFlags } from '@agent-device/contracts/command';
import {
  buildRemoteConnectionDaemonState,
  hashRemoteConfigFile,
  readRemoteConnectionState,
  type RemoteConnectionState,
} from '../../remote/remote-connection-state.ts';

export type ConnectContext = {
  session: string;
  remoteConfigHash: string;
  daemon: RemoteConnectionState['daemon'];
  previous: RemoteConnectionState | null;
};

export function resolveConnectContext(options: {
  stateDir: string;
  flags: CliFlags;
  remoteConfigPath: string;
}): ConnectContext {
  const { stateDir, flags, remoteConfigPath } = options;
  // The active-session pointer is host-global convenience state, not caller identity. Reusing it
  // here lets an unrelated process adopt and overwrite another process's provider connection.
  // Unscoped connects therefore mint a new identity; deliberate reconnects name their session.
  const session = flags.session ?? createRemoteSessionName();
  const previous = flags.session ? readRemoteConnectionState({ stateDir, session }) : null;
  return {
    session,
    previous,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon: buildRemoteConnectionDaemonState(flags),
  };
}

function createRemoteSessionName(): string {
  return `adc-${crypto.randomBytes(16).toString('hex')}`;
}
