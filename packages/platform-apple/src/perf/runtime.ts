import path from 'node:path';
import type { ApplePerfHost } from '@agent-device/contracts/perf-runtime-host';
import {
  createPerfNativeOperations,
  missingPerfAppMetric,
  missingPerfSnapshotAppError,
  settlePerfMetric,
  unsupportedPerfMemoryArtifact,
} from '@agent-device/contracts/perf-runtime-operation-builder';
import type { PerfRuntimeOperations } from '@agent-device/contracts/perf-runtime';
import type { RuntimeOwnerRef } from '@agent-device/contracts/platform-runtime';
import type { DeviceInfo } from '@agent-device/kernel/device';

export function createApplePerfOperations(
  params: Readonly<{
    resolveHost(): ApplePerfHost;
    device: DeviceInfo;
    owner: RuntimeOwnerRef;
  }>,
): PerfRuntimeOperations {
  const { resolveHost, device, owner } = params;
  return Object.freeze({
    ...createPerfNativeOperations({
      platform: 'Apple',
      expectedProfileKind: 'xctrace',
      start: async (input) => await resolveHost().start(device, owner, input),
      reattach: async (input) => await resolveHost().reattach(device, input),
      cleanup: async (input) => await resolveHost().cleanup(device, input),
      writeProfileReport: async (input) => await resolveHost().writeProfileReport(input),
    }),
    perfFrames: async ({ appId }) => ({
      metric: appId
        ? await settlePerfMetric(resolveHost().sampleFrames(device, appId))
        : missingPerfAppMetric('Apple', 'bundle ID'),
      sampling: await resolveHost().frameSampling(device),
    }),
    perfMemorySample: async ({ appId }) => ({
      metric: appId
        ? await settlePerfMetric(resolveHost().sampleMemory(device, appId))
        : missingPerfAppMetric('Apple', 'bundle ID'),
      sampling: await resolveHost().memorySampling(device),
    }),
    perfMemorySnapshot: async ({ appId, kind, outPath, artifactsDir }) => {
      const resolvedKind = kind ?? 'memgraph';
      const support = {
        ...(await resolveHost().memorySnapshotSupport(device)),
        androidHprof: false,
        heapprofd: false,
      };
      if (resolvedKind !== 'memgraph') {
        return unsupportedPerfMemoryArtifact(
          'Apple',
          resolvedKind,
          support,
          'Use perf memory snapshot --kind memgraph for supported Apple app sessions.',
        );
      }
      if (!appId) throw missingPerfSnapshotAppError();
      const outputPath =
        outPath ?? path.join(artifactsDir, `memory-memgraph-${timestampToken()}.memgraph`);
      return {
        artifact: await resolveHost().captureMemorySnapshot(device, appId, outputPath),
        support,
        sampling: {
          method: 'xcrun memgraph',
          description: 'Native Apple memory graph captured for offline inspection.',
          defaultKind: 'memgraph',
          artifactOnly: true,
        },
      };
    },
  });
}

function timestampToken(): string {
  return new Date().toISOString().replaceAll(/[:.]/g, '-');
}
