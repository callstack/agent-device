/**
 * Dormant Simulator AX acquisition. The implementation is loaded only when a caller explicitly
 * creates the source; importing this facet keeps the platform package's startup surface inert.
 */
export type {
  SnapshotSourceFailure,
  SnapshotSourceFailureKind,
  SnapshotSourceLimits,
  SnapshotSourceOutcome,
  SnapshotSourceRequest,
  SnapshotSourceTarget,
} from './snapshot-source/types.ts';

import type { SnapshotSourceOutcome, SnapshotSourceRequest } from './snapshot-source/types.ts';

export type SimulatorSnapshotSource = Readonly<{
  acquire(request: SnapshotSourceRequest): Promise<SnapshotSourceOutcome>;
  close(): Promise<void>;
}>;

export function createSimulatorSnapshotSource(): SimulatorSnapshotSource {
  let implementation:
    | Promise<import('./snapshot-source/adapter.ts').SimulatorSnapshotSource>
    | undefined;
  let closed = false;
  const load = async () => {
    implementation ??= import('./snapshot-source/adapter.ts').then(
      ({ createSimulatorSnapshotSource: create }) => create(),
    );
    return await implementation;
  };
  return {
    acquire: async (request) => {
      if (closed) {
        return {
          stage: 'failed',
          failure: { kind: 'unsupported', code: 'source-closed' },
        };
      }
      return await (await load()).acquire(request);
    },
    close: async () => {
      closed = true;
      if (implementation) await (await implementation).close();
    },
  };
}
