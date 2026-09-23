export {
  buildAppleFrameSamplingMetadata,
  buildAppleMemorySamplingMetadata,
  buildAppleMemorySnapshotSupport,
  captureAppleMemorySnapshot,
  sampleAppleFramePerf,
  sampleAppleMemoryPerf,
} from './core/perf.ts';
export async function readAppleProcessSamples(
  ...args: Parameters<(typeof import('./core/perf-target.ts'))['readAppleProcessSamples']>
): ReturnType<(typeof import('./core/perf-target.ts'))['readAppleProcessSamples']> {
  const { readAppleProcessSamples: run } = await import('./core/perf-target.ts');
  return run(...args);
}

export async function resolveAppleExecutable(
  ...args: Parameters<(typeof import('./core/perf-target.ts'))['resolveAppleExecutable']>
): ReturnType<(typeof import('./core/perf-target.ts'))['resolveAppleExecutable']> {
  const { resolveAppleExecutable: run } = await import('./core/perf-target.ts');
  return run(...args);
}

export async function resolveIosDevicePerfTarget(
  ...args: Parameters<(typeof import('./core/perf-target.ts'))['resolveIosDevicePerfTarget']>
): ReturnType<(typeof import('./core/perf-target.ts'))['resolveIosDevicePerfTarget']> {
  const { resolveIosDevicePerfTarget: run } = await import('./core/perf-target.ts');
  return run(...args);
}

export {
  cleanupAppleXctracePerfCapture,
  isRetryableIosDeviceTraceRecordFailure,
  resolveIosDevicePerfHint,
  startAppleXctracePerfCapture,
  stopAppleXctracePerfCapture,
  writeAppleXctracePerfReport,
  type AppleXctraceCpuProfileReport,
  type AppleXctracePerfCapture,
  type AppleXctracePerfMode,
  type AppleXctracePerfResult,
} from './core/perf-xctrace.ts';
