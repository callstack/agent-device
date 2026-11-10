import { AppError } from '@agent-device/kernel/errors';
import {
  createSnapshotBridgeSource,
  SNAPSHOT_BRIDGE_PRODUCER,
  type SnapshotBridgeSource,
} from './bridge-source.ts';
import { SnapshotBridgeManager } from './lifecycle.ts';
import { resolveSnapshotSourceLimits } from './limits.ts';
import { createSnapshotSourceDeadline, remainingSnapshotSourceMs } from './deadline.ts';
import { createSnapshotBridgePreparation } from './preparation.ts';
import type { SnapshotSourceHost, SnapshotSourceLimits, SnapshotSourceTarget } from './types.ts';

export type SimulatorSnapshotSourceOptions = Readonly<{
  host: SnapshotSourceHost;
  limits?: Partial<SnapshotSourceLimits>;
  sourceRoot?: string;
  cacheRoot?: string;
}>;

export type SimulatorSnapshotSource = SnapshotBridgeSource<SnapshotSourceTarget>;

/** The bridge read on a local Simulator, through a guest bridge process the host starts and owns. */
export function createSimulatorSnapshotSource(
  options: SimulatorSnapshotSourceOptions,
): SimulatorSnapshotSource {
  const host = options.host;
  const manager = new SnapshotBridgeManager(host);
  // Preparation is daemon-scoped work: it reads the toolchain identity, fingerprints the bridge
  // source and may compile it. It runs detached so no capture's deadline pays for it (#2491).
  const preparation = createSnapshotBridgePreparation({
    host,
    limits: resolveSnapshotSourceLimits(options.limits),
    producer: SNAPSHOT_BRIDGE_PRODUCER,
    sourceRoot: options.sourceRoot,
    cacheRoot: options.cacheRoot,
  });
  return createSnapshotBridgeSource({
    diagnostics: host,
    ...(options.limits ? { limits: options.limits } : {}),
    transport: {
      name: 'guest-process',
      validateTarget,
      prepare: async (target, deadline) => {
        const readinessDeadline = createSnapshotSourceDeadline(
          Math.min(2000, remainingSnapshotSourceMs(deadline, 'bridge-readiness-deadline')),
          deadline.signal,
        );
        const bridge = await preparation.readyBinary(
          target.runtime,
          deadline,
          'bridge-preparation-deadline',
          readinessDeadline,
        );
        return async (read) =>
          await manager.request({ ...read, target, bridge, readinessDeadline });
      },
      close: async () => {
        // A bridge build that outlives this source answers to nobody: no request is waiting on it
        // and its cache write would land after the source is gone (#2491).
        await Promise.all([preparation.close(), manager.close()]);
      },
    },
  });
}

function validateTarget(target: SnapshotSourceTarget): void {
  if (
    !target.simulator.udid.trim() ||
    !target.runtime.trim() ||
    !target.generation.trim() ||
    !Number.isSafeInteger(target.pid) ||
    target.pid <= 0
  ) {
    throw new AppError('INVALID_ARGS', 'Simulator snapshot source target identity is incomplete');
  }
}
