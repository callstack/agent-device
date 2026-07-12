import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import type { SnapshotNode, SnapshotState } from '../../../kernel/snapshot.ts';
import type { DaemonMaestroRuntimeDependencies } from '../daemon-runtime-port.ts';

export type CapturedDaemonRequest = Pick<
  DaemonRequest,
  'command' | 'positionals' | 'input' | 'flags'
>;

export const IOS_FRAME = { x: 0, y: 0, width: 402, height: 874 } as const;

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
): DaemonMaestroRuntimeDependencies {
  return {
    now: () => now.value,
    sleep: async (milliseconds) => {
      now.value += milliseconds;
    },
  };
}

export function makeInvoke(
  requests: CapturedDaemonRequest[],
  response: DaemonInvokeFn = async (request) => {
    requests.push({
      command: request.command,
      positionals: request.positionals,
      input: request.input,
      flags: request.flags,
    });
    return { ok: true, data: {} };
  },
): DaemonInvokeFn {
  return async (request) => {
    requests.push({
      command: request.command,
      positionals: request.positionals,
      input: request.input,
      flags: request.flags,
    });
    return await response(request);
  };
}
