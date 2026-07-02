import type { RunnerLogicalLeaseContext } from '../../../../core/runner-lease-context.ts';
import type { ExecResult } from '../../../../utils/exec.ts';
import type { DeviceInfo } from '../../../../kernel/device.ts';
import type { RunnerXctestrunArtifact } from './runner-xctestrun.ts';
import type { RunnerLease } from './runner-lease.ts';

// The runner process seen through the session: pid for liveness/kill-tree and
// exitCode for early-exit detection. A spawned ChildProcess satisfies this
// structurally; adopted runners (whose spawner died) provide a pid-backed
// surrogate — which is why the session must not assume streams or kill() here.
export type RunnerProcessHandle = {
  pid?: number | undefined;
  exitCode: number | null;
};

export type RunnerSession = {
  sessionId: string;
  device: DeviceInfo;
  deviceId: string;
  port: number;
  xctestrunPath: string;
  xctestrunArtifact?: RunnerXctestrunArtifact;
  jsonPath: string;
  testPromise: Promise<ExecResult>;
  child: RunnerProcessHandle;
  ready: boolean;
  startupTimeoutMs?: number;
  // Records the last allowlisted mutating interaction that the runner confirmed
  // healthy (parsed ok, non-runnerFatal) for a given app bundle. Lives only on
  // the session object so it dies with every invalidation/restart (#702).
  lastHealthyMutation?: { atMs: number; appBundleId?: string };
  startupTimings?: Record<string, number>;
  startupTimingsReported?: boolean;
  logicalLeaseContext?: RunnerLogicalLeaseContext;
  simulatorSetRedirect?: { release: () => Promise<void> };
  lease?: RunnerLease;
};

export function buildRunnerSessionId(deviceId: string, port: number): string {
  return `${deviceId}:${port}:${Date.now()}`;
}

export function normalizeRunnerStartupTimeoutMs(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}
