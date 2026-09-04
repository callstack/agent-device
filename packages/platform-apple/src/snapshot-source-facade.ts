/**
 * Dormant Simulator AX acquisition. The implementation is loaded only when a caller explicitly
 * creates the source; importing this facet keeps the platform package's startup surface inert.
 */
export type {
  SnapshotSourceBridgeBinary,
  SnapshotSourceFailure,
  SnapshotSourceFailureKind,
  SnapshotSourceHost,
  SnapshotSourceLimits,
  SnapshotSourceOutcome,
  SnapshotSourceRequest,
  SnapshotSourceSuccess,
  SnapshotSourceTarget,
} from './snapshot-source/types.ts';
export type {
  SimulatorSnapshotSource,
  SimulatorSnapshotSourceOptions,
} from './snapshot-source/adapter.ts';

export function createSimulatorSnapshotSource(
  options: import('./snapshot-source/adapter.ts').SimulatorSnapshotSourceOptions = {},
): import('./snapshot-source/adapter.ts').SimulatorSnapshotSource {
  let implementation:
    | Promise<import('./snapshot-source/adapter.ts').SimulatorSnapshotSource>
    | undefined;
  const load = async () => {
    implementation ??= import('./snapshot-source/adapter.ts').then(
      ({ createSimulatorSnapshotSource: create }) => create(options),
    );
    return await implementation;
  };
  return {
    prepare: async (input) => await (await load()).prepare(input),
    acquire: async (request) => await (await load()).acquire(request),
    acquireOutcome: async (request) => await (await load()).acquireOutcome(request),
    close: async () => {
      if (implementation) await (await implementation).close();
    },
  };
}
