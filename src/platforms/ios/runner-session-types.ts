import type { RunnerLogicalLeaseContext } from '../../core/runner-lease-context.ts';
import type { ExecResult, ExecBackgroundResult } from '../../utils/exec.ts';
import type { DeviceInfo } from '../../kernel/device.ts';
import type { RunnerXctestrunArtifact } from './runner-xctestrun.ts';
import type { RunnerLease } from './runner-lease.ts';

export type RunnerSession = {
  sessionId: string;
  device: DeviceInfo;
  deviceId: string;
  port: number;
  xctestrunPath: string;
  xctestrunArtifact?: RunnerXctestrunArtifact;
  jsonPath: string;
  testPromise: Promise<ExecResult>;
  child: ExecBackgroundResult['child'];
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
