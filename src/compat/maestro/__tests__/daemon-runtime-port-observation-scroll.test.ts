import { expect, test } from 'vitest';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('fails scrollUntilVisible when the target stays absent', async () => {
  const clock = { value: 0 };
  const requests: DaemonRequest[] = [];
  const invoke: DaemonInvokeFn = async (request) => {
    requests.push(request);
    if (request.command === 'scroll') {
      clock.value += Number(request.input?.durationMs ?? 0);
      return { ok: true, data: {} };
    }
    return request.command === 'snapshot'
      ? {
          ok: true,
          data: {
            createdAt: 0,
            nodes: [
              {
                index: 0,
                type: 'Application',
                rect: { x: 0, y: 0, width: 402, height: 874 },
              },
            ],
          },
        }
      : { ok: true, data: {} };
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });

  await expect(
    port.execute({
      command: {
        kind: 'scrollUntilVisible',
        source: { line: 2 },
        element: { text: 'Discover' },
        direction: 'up',
        timeout: 500,
      },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'Maestro scrollUntilVisible target did not become visible.',
  });
  expect(requests.filter(({ command }) => command === 'scroll')).toHaveLength(1);
  expect(requests.filter(({ command }) => command === 'snapshot')).toHaveLength(3);
});

test('scrolls until the target is fully visible in the screen viewport', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [
            {
              index: 0,
              type: 'Application',
              rect: { x: 0, y: 0, width: 402, height: 874 },
            },
            {
              index: 1,
              parentIndex: 0,
              type: 'Text',
              label: 'Discover',
              rect:
                snapshots === 1
                  ? { x: 20, y: 850, width: 120, height: 48 }
                  : { x: 20, y: 700, width: 120, height: 48 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  const result = await port.execute({
    command: {
      kind: 'scrollUntilVisible',
      source: { line: 2 },
      element: { text: 'Discover' },
      direction: 'up',
      timeout: 2_000,
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.filter(({ command }) => command === 'scroll')).toHaveLength(1);
  expect(requests.filter(({ command }) => command === 'snapshot')).toHaveLength(3);
  expect(result.observation).toMatchObject({ generation: 1, matched: true });
  expect(result.observation?.identity).toMatch(/^maestro-observation-/);
});

test('does not treat a target larger than the viewport as fully visible', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [
            { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
            {
              index: 1,
              parentIndex: 0,
              type: 'Text',
              label: 'Discover',
              rect:
                snapshots <= 4
                  ? { x: 0, y: 0, width: 402, height: 1_200 }
                  : { x: 20, y: 700, width: 120, height: 48 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'scrollUntilVisible',
      source: { line: 2 },
      element: { text: 'Discover' },
      direction: 'up',
      timeout: 2_000,
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.filter(({ command }) => command === 'scroll')).toHaveLength(2);
});
