import fs from 'node:fs';
import path from 'node:path';
import type { OwnerIdentity } from '@agent-device/host-kit/process';

/**
 * Publishes the daemon registration a running daemon writes for its state dir.
 * Claim ownership is only reachable through the daemon named there, so tests
 * that exercise reachability have to stand one in.
 */
export function publishDaemonRegistration(stateDir: string, owner: OwnerIdentity): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    path.join(stateDir, 'daemon.json'),
    JSON.stringify({
      port: 1,
      transport: 'socket',
      token: 'test-token',
      pid: owner.pid,
      ...(owner.startTime === null ? {} : { processStartTime: owner.startTime }),
      stateDir,
    }),
  );
}
