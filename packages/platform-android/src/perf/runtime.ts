import path from 'node:path';
import type { AndroidPerfHost } from '@agent-device/contracts/perf-runtime-host';
import {
  createPerfNativeOperations,
  missingPerfAppMetric,
  missingPerfSnapshotAppError,
  settlePerfMetric,
  unsupportedPerfMemoryArtifact,
} from '@agent-device/contracts/perf-runtime-operation-builder';
import type { PerfData, PerfRuntimeOperations } from '@agent-device/contracts/perf-runtime';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createAndroidPerfOperations(
  params: Readonly<{
    resolveHost(): AndroidPerfHost;
    device: DeviceInfo;
    owner: RuntimeOwnerRef;
  }>,
): PerfRuntimeOperations {
  const { resolveHost, device, owner } = params;
  return Object.freeze({
    ...createPerfNativeOperations({
      platform: 'Android',
      expectedProfileKind: 'simpleperf',
      start: async (input) => await resolveHost().start(device, owner, input),
      reattach: async (input) => await resolveHost().reattach(device, input),
      cleanup: async (input) => await resolveHost().cleanup(device, input),
      writeProfileReport: async (input) => await resolveHost().writeProfileReport(device, input),
    }),
    perfFrames: async ({ appId }) => ({
      metric: appId
        ? await settlePerfMetric(resolveHost().sampleFrames(device, appId))
        : missingPerfAppMetric('Android', 'package'),
      sampling: {
        method: 'adb-shell-dumpsys-gfxinfo-framestats',
        description:
          'Rendered-frame health from the current adb shell dumpsys gfxinfo <package> framestats window. Dropped frames use Android gfxinfo janky-frame/frame-deadline data when available; this is not video recording FPS.',
        unit: 'percent',
        primaryField: 'droppedFramePercent',
        window: 'since previous Android gfxinfo reset or app process start',
        resetsAfterRead: true,
        relatedActionsLimit: 12,
      },
    }),
    perfMemorySample: async ({ appId }) => ({
      metric: appId
        ? await settlePerfMetric(resolveHost().sampleMemory(device, appId))
        : missingPerfAppMetric('Android', 'package'),
      sampling: {
        method: 'adb-shell-dumpsys-meminfo',
        description:
          'Memory snapshot from adb shell dumpsys meminfo <package>. Values are reported in kilobytes.',
        unit: 'kB',
        topConsumerLimit: 5,
      },
    }),
    perfMemorySnapshot: async ({ appId, kind, outPath, artifactsDir }) => {
      const resolvedKind = kind ?? 'android-hprof';
      const support = androidMemorySnapshotSupport();
      if (resolvedKind !== 'android-hprof') {
        return unsupportedPerfMemoryArtifact(
          'Android',
          resolvedKind,
          support,
          'Use perf memory snapshot --kind android-hprof for Android Java heap artifacts.',
        );
      }
      if (!appId) throw missingPerfSnapshotAppError();
      const outputPath =
        outPath ?? path.join(artifactsDir, `memory-android-hprof-${timestampToken()}.hprof`);
      return {
        artifact: await resolveHost().captureMemorySnapshot(device, appId, outputPath),
        support,
        sampling: {
          method: 'adb-shell-am-dumpheap',
          description:
            'Java heap dump captured with adb shell am dumpheap, pulled to a local artifact path.',
          defaultKind: 'android-hprof',
          artifactOnly: true,
        },
      };
    },
  });
}

function androidMemorySnapshotSupport(): PerfData {
  return {
    platform: 'android',
    defaultKind: 'android-hprof',
    androidHprof: true,
    memgraph: false,
    heapprofd: false,
    heapprofdDecision:
      'Deferred until Android Perfetto/heapprofd plumbing is available in the perf trace slice.',
  };
}

function timestampToken(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
