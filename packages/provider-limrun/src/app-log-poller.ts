import type { AppLogLiveHandle, AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import {
  startAppLogPoller,
  type AppLogPollerReader,
} from '@agent-device/capture-kit/app-log-polling';

export type LimrunAppLogReader = AsyncDisposable &
  Readonly<{
    platform: 'ios' | 'android';
    leaseId: string;
    instanceId: string;
    readLogs(appBundleId: string, lineLimit: number): Promise<string>;
  }>;

const LIMRUN_CLEANUP_FAILURE_MESSAGE = 'Limrun app-log cleanup did not settle every owned resource';

export async function startLimrunAppLogPoller(options: {
  host: AppLogRuntimeHost;
  reader: LimrunAppLogReader;
  appBundleId: string;
  outputPath: string;
}): Promise<AppLogLiveHandle> {
  return await startAppLogPoller({
    host: options.host,
    reader: options.reader satisfies AppLogPollerReader,
    backend: backendForReader(options.reader),
    appBundleId: options.appBundleId,
    outputPath: options.outputPath,
    cleanupFailureMessage: LIMRUN_CLEANUP_FAILURE_MESSAGE,
  });
}

function backendForReader(reader: LimrunAppLogReader): 'ios-simulator' | 'android' {
  return reader.platform === 'ios' ? 'ios-simulator' : 'android';
}
