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
  const session = flags.session ?? createRemoteSessionName(stateDir);
  const previous = flags.session ? readRemoteConnectionState({ stateDir, session }) : null;
  return {
    session,
    previous,
    remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
    daemon: buildRemoteConnectionDaemonState(flags),
  };
}

function createRemoteSessionName(stateDir: string): string {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = `adc-${crypto.randomBytes(3).toString('hex')}`;
    if (!readRemoteConnectionState({ stateDir, session: candidate })) {
      return candidate;
    }
  }
  return `adc-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`;
}
