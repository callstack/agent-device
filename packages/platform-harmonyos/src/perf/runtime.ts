import type { HarmonyPerfHost } from '@agent-device/contracts/perf-runtime-host';
import {
  missingPerfAppMetric,
  settlePerfMetric,
} from '@agent-device/contracts/perf-runtime-operation-builder';
import type { PerfRuntimeOperations } from '@agent-device/contracts/perf-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createHarmonyPerfOperations(
  params: Readonly<{
    resolveHost(): HarmonyPerfHost;
    device: DeviceInfo;
  }>,
): Pick<PerfRuntimeOperations, 'perfFrames' | 'perfMemorySample' | 'perfMemorySnapshot'> {
  const { resolveHost, device } = params;
  const frameUnavailable = {
    available: false,
    reason:
      'Dropped-frame sampling is currently available only on Android app sessions and connected iOS device app sessions.',
  } as const;
  return Object.freeze({
    perfFrames: async () => ({ metric: frameUnavailable, sampling: frameUnavailable }),
    perfMemorySample: async ({ appId }) => ({
      metric: appId
        ? await settlePerfMetric(resolveHost().sampleMemory(device, appId))
        : missingPerfAppMetric('HarmonyOS', 'bundle'),
      sampling: {
        method: 'hdc-shell-proc-status',
        description:
          'Resident memory snapshot from HarmonyOS /proc/<pid>/status. Values are reported in kilobytes.',
        unit: 'kB',
        topConsumerLimit: 1,
      },
    }),
    perfMemorySnapshot: async ({ kind }) => ({
      artifact: {
        available: false,
        kind: kind ?? 'memgraph',
        reason: 'Memory snapshot artifacts are not supported on harmonyos.',
        hint: 'Use perf memory sample where supported, or run the snapshot against Android, iOS simulator, or macOS.',
        support: {
          platform: 'harmonyos',
          defaultKind: 'memgraph',
          androidHprof: false,
          memgraph: false,
          heapprofd: false,
        },
      },
      sampling: {
        method: 'unsupported',
        description: 'HarmonyOS memory snapshot capture is not available through HDC.',
        artifactOnly: true,
      },
    }),
  });
}
