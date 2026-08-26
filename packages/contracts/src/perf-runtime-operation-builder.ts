import type { PerfData, PerfRuntimeOperations } from './perf-runtime.ts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';

export async function settlePerfMetric(promise: Promise<object>): Promise<PerfData> {
  try {
    return { available: true, ...(await promise) };
  } catch (error) {
    const normalized = normalizeError(error);
    return { available: false, reason: normalized.message, error: normalized };
  }
}

export function missingPerfAppMetric(platform: string, appIdentity: string): PerfData {
  return {
    available: false,
    reason: `No ${platform} app ${appIdentity} is associated with this session. Run open <app> first.`,
  };
}

export function unsupportedPerfMemoryArtifact(
  platform: string,
  kind: string,
  support: PerfData,
  hint: string,
): PerfData {
  return {
    artifact: {
      available: false,
      kind,
      reason: `${platform} perf memory snapshot does not support ${kind}.`,
      hint,
      support,
    },
    support,
  };
}

export function missingPerfSnapshotAppError(): AppError {
  return new AppError('INVALID_ARGS', 'perf memory snapshot requires an active app session', {
    hint: 'Run open <app> first so perf memory snapshot can resolve the app process.',
  });
}

export function createPerfNativeOperations(
  params: Readonly<{
    platform: string;
    expectedProfileKind: 'xctrace' | 'simpleperf';
    start: PerfRuntimeOperations['perfNativeCaptureStart'];
    reattach: PerfRuntimeOperations['perfNativeCaptureReattach'];
    cleanup: PerfRuntimeOperations['perfNativeCaptureCleanup'];
    writeProfileReport: PerfRuntimeOperations['perfProfileReport'];
  }>,
): Pick<
  PerfRuntimeOperations,
  | 'perfNativeCaptureStart'
  | 'perfNativeCaptureReattach'
  | 'perfNativeCaptureCleanup'
  | 'perfProfileReport'
> {
  return Object.freeze({
    perfNativeCaptureStart: params.start,
    perfNativeCaptureReattach: params.reattach,
    perfNativeCaptureCleanup: params.cleanup,
    perfProfileReport: async (input) => {
      if (input.kind !== params.expectedProfileKind) {
        throw new AppError(
          'INVALID_ARGS',
          `${params.platform} native perf requires --kind ${params.expectedProfileKind}, not ${input.kind}`,
        );
      }
      return await params.writeProfileReport(input);
    },
  });
}
