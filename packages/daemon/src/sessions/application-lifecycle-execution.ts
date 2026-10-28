import {
  getRequestExecutionDeadlineMs,
  getRequestResultDeadlineMs,
} from '@agent-device/host-kit/request';
import { resolvePlannedOperations } from '../core/execution-plan.ts';
import type { ApplicationLifecycleExecution } from '@agent-device/contracts/application-lifecycle-runtime';
import { resolveRunnerLogicalLeaseContext } from '../core/lease-context.ts';
import type { DaemonRequest } from '../core/daemon-request.ts';

/** Builds the request-scoped context consumed by an already-admitted lifecycle binding. */
export function applicationLifecycleExecutionFromRequest(
  req: DaemonRequest,
  logPath: string,
  traceLogPath?: string,
): ApplicationLifecycleExecution {
  return {
    requestDeadlineAtMs: requestDeadlineAtMs(req),
    requestId: req.meta?.requestId,
    logPath,
    traceLogPath,
    verbose: req.flags?.verbose,
    activity: req.flags?.activity,
    launchConsole: req.flags?.launchConsole,
    launchArgs: req.flags?.launchArgs,
    clearAppState: req.flags?.clearAppState,
    iosXctestrunFile: req.flags?.iosXctestrunFile,
    iosXctestDerivedDataPath: req.flags?.iosXctestDerivedDataPath,
    iosXctestEnvDir: req.flags?.iosXctestEnvDir,
    runnerLeaseContext: resolveRunnerLogicalLeaseContext(req),
    plannedOperations: resolvePlannedOperations(req.internal?.executionPlan),
  };
}

/**
 * An enforced daemon deadline is the request's deadline. Otherwise it is the result deadline the
 * transport that admitted the request (or its parent) set, ahead of the client's envelope.
 */
function requestDeadlineAtMs(req: DaemonRequest): number | undefined {
  const requestId = req.meta?.requestId;
  return getRequestExecutionDeadlineMs(requestId) ?? getRequestResultDeadlineMs(requestId);
}
