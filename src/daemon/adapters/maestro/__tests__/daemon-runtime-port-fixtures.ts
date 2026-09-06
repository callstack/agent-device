import type { DaemonRequest } from '../../../daemon-request.ts';
import type { SnapshotNode, SnapshotState } from '@agent-device/kernel/snapshot';
import type { CreateDaemonMaestroRuntimeOperationsOptions } from '../daemon-runtime-port.ts';

export function makeSnapshot(
  nodes: Array<Omit<SnapshotNode, 'ref'> & { ref?: string }>,
): SnapshotState {
  return {
    createdAt: 0,
    nodes: nodes.map((node) => ({ ref: `e${node.index + 1}`, ...node })),
  };
}

export function makeBaseRequest(
  overrides: Partial<Pick<DaemonRequest, 'token' | 'session' | 'flags' | 'meta'>> = {},
): Omit<DaemonRequest, 'command' | 'positionals'> {
  return {
    token: 'test-token',
    session: 'maestro-test',
    ...overrides,
  };
}

export function makeDependencies(
  now: { value: number } = { value: 0 },
): CreateDaemonMaestroRuntimeOperationsOptions['dependencies'] {
  return {
    now: () => now.value,
    sleep: async (milliseconds) => {
      now.value += milliseconds;
    },
  };
}
