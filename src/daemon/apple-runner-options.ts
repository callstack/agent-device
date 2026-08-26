import type { AppleRunnerLifecycleOptions } from '@agent-device/platform-apple/runner';
import type { DaemonRequest } from './types.ts';

export type AppleRunnerRequestOptions = Pick<
  AppleRunnerLifecycleOptions,
  | 'verbose'
  | 'logPath'
  | 'traceLogPath'
  | 'requestId'
  | 'runnerLeaseContext'
  | 'iosXctestrunFile'
  | 'iosXctestDerivedDataPath'
  | 'iosXctestEnvDir'
>;

export function buildAppleRunnerRequestOptions(params: {
  req: Pick<DaemonRequest, 'flags' | 'meta'>;
  logPath?: string;
  traceLogPath?: string;
}): AppleRunnerRequestOptions {
  const { req, logPath, traceLogPath } = params;
  return {
    verbose: req.flags?.verbose,
    logPath,
    traceLogPath,
    requestId: req.meta?.requestId,
    iosXctestrunFile: req.flags?.iosXctestrunFile,
    iosXctestDerivedDataPath: req.flags?.iosXctestDerivedDataPath,
    iosXctestEnvDir: req.flags?.iosXctestEnvDir,
  };
}
