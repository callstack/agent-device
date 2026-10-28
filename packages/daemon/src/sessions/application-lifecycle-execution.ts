import {
  getRequestAdmittedAtMs,
  getRequestExecutionDeadlineMs,
} from '@agent-device/host-kit/request';
import { resolvePlannedOperations } from '../core/execution-plan.ts';
import { resolveDaemonRequestBudgetMs } from '../core/daemon-command-registry.ts';
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
 * An enforced daemon deadline is the request's deadline. Otherwise the client envelope started when
 * the transport admitted the request, so the deadline is that moment plus the envelope's daemon
 * budget.
 */
function requestDeadlineAtMs(req: DaemonRequest): number | undefined {
  const requestId = req.meta?.requestId;
  const enforcedAtMs = getRequestExecutionDeadlineMs(requestId);
  if (enforcedAtMs !== undefined) return enforcedAtMs;
  const admittedAtMs = getRequestAdmittedAtMs(requestId);
  const budgetMs = resolveDaemonRequestBudgetMs(req);
  return admittedAtMs === undefined || budgetMs === undefined ? undefined : admittedAtMs + budgetMs;
}
