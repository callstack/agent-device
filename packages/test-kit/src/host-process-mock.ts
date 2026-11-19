import { beforeEach, vi } from 'vitest';
import type * as HostProcess from '@agent-device/host-kit/process';
import { LIFETIME_TOKEN } from './process-lifetime.fixtures.ts';

type HostProcessModule = typeof HostProcess;
type HostProcessIdentityObservation = HostProcess.HostProcessIdentityObservation;

/**
 * Pins this test process's start time to a constant on the host-kit process module, so claim and
 * lock identity checks behave the same on every host. Call it once at module scope (it registers a `beforeEach`, so `vi.restoreAllMocks` between tests cannot unpin it) with the
 * namespace the test imported: `pinOwnProcessStartTime(hostProcess)` where
 * `import * as hostProcess from '@agent-device/host-kit/process'`. It spies the module in place
 * rather than replacing it with `vi.mock`, so the helper is never imported while the module it
 * pins is still being mocked.
 */
export function pinOwnProcessStartTime(hostProcess: HostProcessModule): void {
  beforeEach(() => installPin(hostProcess));
}

function installPin(hostProcess: HostProcessModule): void {
  // The shared canonical POSIX birth token: provenanced, so a different `posix:` token in a
  // record still proves PID reuse while raw legacy renderings stay unknown.
  const ownStartTime = LIFETIME_TOKEN;
  vi.spyOn(hostProcess, 'readCurrentOwnerIdentity').mockImplementation(() => ({
    pid: process.pid,
    startTime: ownStartTime,
  }));
  vi.spyOn(hostProcess, 'readProcessStartTime').mockImplementation((pid: number) =>
    pid === process.pid ? ownStartTime : null,
  );
  const observeOwnProcess = (pids: Iterable<number>) => {
    const observations = new Map<number, HostProcessIdentityObservation>();
    if ([...pids].includes(process.pid)) {
      observations.set(process.pid, { state: 'S', startTime: ownStartTime });
    }
    return observations;
  };
  vi.spyOn(hostProcess, 'readHostProcessIdentityObservations').mockImplementation(
    observeOwnProcess,
  );
  vi.spyOn(hostProcess, 'readHostProcessIdentityObservationsAsync').mockImplementation(
    async (pids: Iterable<number>) => observeOwnProcess(pids),
  );
}
