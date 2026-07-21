import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon/types.ts';
import { MAESTRO_OBSERVATION_POLL_MS } from '../daemon-runtime-port-observation.ts';
import { createDaemonMaestroSnapshotSource } from '../daemon-runtime-port-snapshot-source.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('reuses bound observations and seeds a pending stability comparison', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  const source = createDaemonMaestroSnapshotSource({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          nodes: [
            {
              index: 0,
              identifier: 'ready',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });
  const context = { generation: 0, env: {} };

  const snapshot = await source.capture(context);
  const observation = source.bindObservation({ generation: 0, matched: true });

  expect(source.reuseObservation({ ...context, cachedObservation: observation })).toBe(snapshot);

  source.requireStability(0);
  await source.settlePending(context);

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'snapshot']);
  expect(source.readMetrics()).toEqual({ hierarchyCaptures: 2 });
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
  expect(await source.capture(context)).toMatchObject({
    nodes: [{ identifier: 'ready' }],
  });
  expect(requests).toHaveLength(2);
});

test('retains invalidated target evidence only as a mutation stability baseline', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  const source = createDaemonMaestroSnapshotSource({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          nodes: [{ index: 0, identifier: 'ready', rect: { x: 0, y: 0, width: 10, height: 10 } }],
        },
      };
    },
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });
  const beforeMutation = { generation: 0, env: {} };
  const afterMutation = { generation: 1, env: {} };

  await source.capture(beforeMutation);
  source.invalidate(1);
  source.requireStability(1);

  expect(source.reuseObservation(beforeMutation)).toBeUndefined();
  await source.settlePending(afterMutation);

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'snapshot']);
  expect(source.readMetrics()).toEqual({ hierarchyCaptures: 2 });
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});

test('retains a pending stability boundary when settling is canceled', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  const source = createDaemonMaestroSnapshotSource({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return {
        ok: true,
        data: {
          nodes: [{ index: 0, identifier: 'ready', rect: { x: 0, y: 0, width: 10, height: 10 } }],
        },
      };
    },
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });
  const beforeMutation = { generation: 0, env: {} };
  const afterMutation = { generation: 1, env: {} };
  await source.capture(beforeMutation);
  source.invalidate(1);
  source.requireStability(1);

  await expect(
    source.settlePending({ ...afterMutation, signal: AbortSignal.abort() }),
  ).rejects.toThrow('request canceled');
  await source.settlePending(afterMutation);

  expect(requests.map(({ command }) => command)).toEqual(['snapshot', 'snapshot']);
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});

test('rejects a deferred stability baseline consumed by another generation', async () => {
  const source = createDaemonMaestroSnapshotSource({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async () => ({ ok: true, data: { nodes: [] } }),
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  source.requireStability(2);

  await expect(source.settlePending({ generation: 3, env: {} })).rejects.toThrow(
    'stability generation 2 does not match 3',
  );
});

test('consumes deferred hierarchy stability after a same-generation visual wait', async () => {
  const source = createDaemonMaestroSnapshotSource({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async () => ({ ok: true, data: { nodes: [] } }),
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  source.requireStability(2);
  source.consumeStabilityFromVisualWait({ generation: 2, env: {} });

  await expect(source.settlePending({ generation: 2, env: {} })).resolves.toBeUndefined();

  source.requireStability(2);
  expect(() => source.consumeStabilityFromVisualWait({ generation: 3, env: {} })).toThrow(
    'stability generation 2 does not match 3',
  );
});
