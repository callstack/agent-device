import type { AppLogLiveHandle, AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import type { LogBackend } from '@agent-device/contracts/observability';
import { startAppLogPoller, type AppLogPollerReader } from '@agent-device/capture-kit';

const APP_LOG_BACKEND: LogBackend = 'ios-simulator';
const DOUBLESPEED_CLEANUP_FAILURE_MESSAGE =
  'Doublespeed app-log cleanup did not settle every owned resource';

export type DoublespeedAppLogReader = AsyncDisposable &
  Readonly<{
    leaseId: string;
    simulatorId: string;
    readLogs(appBundleId: string, lineLimit: number, signal?: AbortSignal): Promise<string>;
  }>;

export async function startDoublespeedAppLogPoller(options: {
  host: AppLogRuntimeHost;
  reader: DoublespeedAppLogReader;
  appBundleId: string;
  outputPath: string;
}): Promise<AppLogLiveHandle> {
  return await startAppLogPoller({
    host: options.host,
    reader: options.reader satisfies AppLogPollerReader,
    backend: APP_LOG_BACKEND,
    appBundleId: options.appBundleId,
    outputPath: options.outputPath,
    cleanupFailureMessage: DOUBLESPEED_CLEANUP_FAILURE_MESSAGE,
  });
}
