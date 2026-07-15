import { AppError } from '../../kernel/errors.ts';
import type { SnapshotState } from '../../kernel/snapshot.ts';
import type { MaestroObservationIdentity } from './engine-types.ts';
import { MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS } from './compatibility-policy.ts';
import {
  waitForTypedSnapshotStability,
  type MaestroSnapshotReader,
  type MaestroSnapshotSource,
} from './daemon-runtime-port-observation.ts';
import { invokeMaestroPublicOperation } from './daemon-runtime-port-support.ts';
import type { CreateDaemonMaestroRuntimeOperationsOptions } from './daemon-runtime-port-support.ts';

export function createDaemonMaestroSnapshotSource(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
): MaestroSnapshotSource {
  let cached:
    | {
        generation: number;
        snapshot: SnapshotState;
        observationIdentity?: MaestroObservationIdentity;
      }
    | undefined;
  let primed: { generation: number; snapshot: SnapshotState } | undefined;
  let invalidatedBaseline: { generation: number; snapshot: SnapshotState } | undefined;
  let stabilityBaseline: { generation: number; snapshot: SnapshotState } | undefined;
  let stabilityRequiredGeneration: number | undefined;
  let nextObservationIdentity = 0;
  let hierarchyCaptures = 0;

  const captureFresh: MaestroSnapshotReader = async (context) => {
    hierarchyCaptures += 1;
    const data = await invokeMaestroPublicOperation(options, { kind: 'snapshot' });
    if (!data || !Array.isArray(data.nodes)) {
      throw new AppError('COMMAND_FAILED', 'Maestro snapshot did not return node data.');
    }
    const snapshot = data as SnapshotState;
    cached = { generation: context.generation, snapshot };
    return snapshot;
  };

  const capture: MaestroSnapshotReader = async (context) => {
    if (primed?.generation === context.generation) {
      const snapshot = primed.snapshot;
      primed = undefined;
      cached = { generation: context.generation, snapshot };
      return snapshot;
    }
    primed = undefined;
    return await captureFresh(context);
  };

  return {
    capture,
    bindObservation: (observation) => {
      if (cached?.generation !== observation.generation) return observation;
      const identity =
        `maestro-observation-${++nextObservationIdentity}` as MaestroObservationIdentity;
      cached.observationIdentity = identity;
      return { ...observation, identity };
    },
    reuseObservation: (context) => {
      if (context.cachedObservation?.generation !== context.generation) return undefined;
      if (context.cachedObservation.identity === undefined) return undefined;
      if (cached?.generation !== context.generation) return undefined;
      if (context.cachedObservation.identity !== cached.observationIdentity) return undefined;
      return cached.snapshot;
    },
    readMetrics: () => ({ hierarchyCaptures }),
    invalidate: (generation) => {
      invalidatedBaseline =
        cached?.generation === generation - 1
          ? { generation, snapshot: cached.snapshot }
          : undefined;
      cached = undefined;
      primed = undefined;
    },
    requireStability: (generation) => {
      stabilityRequiredGeneration = generation;
      stabilityBaseline =
        invalidatedBaseline?.generation === generation ? invalidatedBaseline : undefined;
      invalidatedBaseline = undefined;
      primed = undefined;
    },
    prime: (generation, snapshot) => {
      primed = { generation, snapshot };
    },
    settlePending: async (context) => {
      if (stabilityRequiredGeneration === undefined) return;
      if (stabilityRequiredGeneration !== context.generation) {
        throw new AppError(
          'COMMAND_FAILED',
          `Maestro stability generation ${stabilityRequiredGeneration} does not match ${context.generation}.`,
        );
      }
      const initialSnapshot =
        cached?.generation === context.generation ? cached.snapshot : stabilityBaseline?.snapshot;
      const stable = await waitForTypedSnapshotStability({
        timeoutMs: MAESTRO_DEFAULT_SETTLE_TIMEOUT_MS,
        context,
        snapshot: captureFresh,
        dependencies: options.dependencies,
        ...(initialSnapshot ? { initialSnapshot } : {}),
      });
      stabilityRequiredGeneration = undefined;
      stabilityBaseline = undefined;
      primed = { generation: context.generation, snapshot: stable.snapshot };
    },
  };
}
