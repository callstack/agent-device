import type { DeviceInfo } from '../../kernel/device.ts';
import { sampleAndroidFramePerf } from './perf-frame.ts';
import type {
  AndroidNativePerfFrameHealthSummary,
  AndroidNativePerfOptions,
  AndroidNativePerfSession,
  AndroidNativePerfStopSummary,
} from './perf-native-types.ts';

export async function buildAndroidNativePerfStopSummary(
  device: DeviceInfo,
  session: AndroidNativePerfSession,
  sizeBytes: number,
  durationMs: number,
  options: AndroidNativePerfOptions,
): Promise<AndroidNativePerfStopSummary> {
  return {
    capture: {
      durationMs,
      packageName: session.packageName,
      appPid: session.appPid,
      artifactPath: session.outPath,
      sizeBytes,
    },
    frameHealth:
      session.kind === 'perfetto'
        ? await sampleAndroidNativePerfFrameHealth(device, session.packageName, options)
        : undefined,
    notes: [
      session.kind === 'perfetto'
        ? 'Frame health is sampled from Android gfxinfo around the trace window; open the Perfetto artifact for timeline root cause.'
        : 'Open the Simpleperf report artifact for symbol-level CPU attribution.',
    ],
  };
}

async function sampleAndroidNativePerfFrameHealth(
  device: DeviceInfo,
  packageName: string,
  options: AndroidNativePerfOptions,
): Promise<AndroidNativePerfFrameHealthSummary> {
  try {
    const sample = await sampleAndroidFramePerf(device, packageName, options);
    return {
      available: true,
      droppedFramePercent: sample.droppedFramePercent,
      droppedFrameCount: sample.droppedFrameCount,
      totalFrameCount: sample.totalFrameCount,
      method: sample.method,
      worstWindows: sample.worstWindows?.slice(0, 3).map((window) => ({
        startOffsetMs: window.startOffsetMs,
        endOffsetMs: window.endOffsetMs,
        missedDeadlineFrameCount: window.missedDeadlineFrameCount,
        worstFrameMs: window.worstFrameMs,
      })),
    };
  } catch (error) {
    return {
      available: false,
      reason: error instanceof Error ? error.message : 'Android frame health was not available',
    };
  }
}
