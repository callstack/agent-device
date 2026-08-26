import type { ApplicationLifecycleExecution } from '@agent-device/contracts/application-lifecycle-runtime';
import { resolveRunnerLogicalLeaseContext } from './lease-context.ts';
import type { DaemonRequest } from './types.ts';

/** Builds the request-scoped context consumed by an already-admitted lifecycle binding. */
export function applicationLifecycleExecutionFromRequest(
  req: DaemonRequest,
  logPath: string,
  traceLogPath?: string,
): ApplicationLifecycleExecution {
  return {
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
  };
}
