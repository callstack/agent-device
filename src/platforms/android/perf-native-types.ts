import type { AndroidAdbExecutor } from './adb-executor.ts';

export const ANDROID_SIMPLEPERF_METHOD = 'adb-shell-simpleperf';
export const ANDROID_PERFETTO_METHOD = 'adb-shell-perfetto';

export const ANDROID_PERF_TIMEOUT_MS = 15_000;
export const ANDROID_NATIVE_PROFILE_TIMEOUT_MS = 30_000;
export const ANDROID_NATIVE_REMOTE_DIR = '/data/local/tmp';
export const ANDROID_PERFETTO_REMOTE_DIR = '/data/misc/perfetto-traces';
export const ANDROID_NATIVE_MAX_SECONDS = 60 * 60;

export type AndroidNativePerfOptions = {
  adb?: AndroidAdbExecutor;
};

export type AndroidNativePerfKind = 'simpleperf' | 'perfetto';

export type AndroidNativePerfType = 'cpu-profile' | 'trace';

export type AndroidNativePerfSession = {
  type: AndroidNativePerfType;
  kind: AndroidNativePerfKind;
  packageName: string;
  appPid: string;
  profilerPid: string;
  remotePath: string;
  outPath: string;
  startedAt: number;
  state: 'running' | 'stopped';
  stoppedAt?: number;
  sizeBytes?: number;
};

export type AndroidNativePerfStartResult = AndroidNativePerfSession & {
  action: 'start';
  platform: 'android';
  method: typeof ANDROID_SIMPLEPERF_METHOD | typeof ANDROID_PERFETTO_METHOD;
  message: string;
};

export type AndroidNativePerfStopResult = AndroidNativePerfSession & {
  action: 'stop';
  platform: 'android';
  durationMs: number;
  method: typeof ANDROID_SIMPLEPERF_METHOD | typeof ANDROID_PERFETTO_METHOD;
  artifact: {
    path: string;
    sizeBytes: number;
  };
  summary: AndroidNativePerfStopSummary;
  message: string;
};

export type AndroidNativePerfStopSummary = {
  capture: {
    durationMs: number;
    packageName: string;
    appPid: string;
    artifactPath: string;
    sizeBytes: number;
  };
  frameHealth?: AndroidNativePerfFrameHealthSummary;
  notes: string[];
};

export type AndroidNativePerfFrameHealthSummary =
  | {
      available: true;
      droppedFramePercent: number;
      droppedFrameCount: number;
      totalFrameCount: number;
      method: string;
      worstWindows?: Array<{
        startOffsetMs?: number;
        endOffsetMs?: number;
        missedDeadlineFrameCount: number;
        worstFrameMs?: number;
      }>;
    }
  | {
      available: false;
      reason: string;
    };

export type AndroidSimpleperfReportResult = {
  action: 'report';
  platform: 'android';
  type: 'cpu-profile-report';
  kind: 'simpleperf';
  packageName: string;
  appPid: string;
  sourceProfilePath: string;
  outPath: string;
  sizeBytes: number;
  generatedAt: string;
  entryCount: number;
  summary: {
    topFunctions: Array<{
      symbol: string;
      binary?: string;
      selfSamplePercent: number;
    }>;
  };
  method: typeof ANDROID_SIMPLEPERF_METHOD;
  message: string;
};
