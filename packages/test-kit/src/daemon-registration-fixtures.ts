import fs from 'node:fs';
import path from 'node:path';
import { writePersistedOwner, type OwnerIdentity } from '@agent-device/host-kit/process';

/**
 * Publishes the daemon registration a running daemon writes for its state dir.
 * Claim ownership is only reachable through the daemon named there, so tests
 * that exercise reachability have to stand one in. Like the production publisher it writes the
 * legacy raw `processStartTime` plus the canonical `processStartTimeToken` beside it.
 */
export function publishDaemonRegistration(stateDir: string, owner: OwnerIdentity): void {
  const persisted = writePersistedOwner(owner);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'daemon.json'),
    JSON.stringify({
      port: 1,
      transport: 'socket',
      token: 'test-token',
      pid: owner.pid,
      ...(owner.startTime === null
        ? {}
        : {
            processStartTime: persisted.startTime,
            // The token field only ever carries a provenanced token; an old-format record has none.
            ...(persisted.birthToken == null
              ? {}
              : { processStartTimeToken: persisted.birthToken }),
          }),
      stateDir,
    }),
  );
}
