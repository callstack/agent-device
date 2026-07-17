import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { MAESTRO_OBSERVATION_POLL_MS } from '../daemon-runtime-port-observation.ts';
import type { MaestroRuntimeCommand } from '../engine-types.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test.each([
  {
    name: 'double tap',
    command: {
      kind: 'doubleTapOn',
      source: { line: 2 },
      target: { space: 'absolute', x: 100, y: 200 },
    },
  },
  {
    name: 'long press',
    command: {
      kind: 'longPressOn',
      source: { line: 2 },
      target: { space: 'absolute', x: 100, y: 200 },
    },
  },
] satisfies { name: string; command: MaestroRuntimeCommand }[])(
  'settles $name before a following gesture',
  async ({ command }) => {
    const requests: DaemonRequest[] = [];
    const clock = { value: 0 };
    const port = createDaemonMaestroRuntimePort({
      baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
      invoke: async (request) => {
        requests.push(request);
        return request.command === 'snapshot'
          ? {
              ok: true,
              data: {
                nodes: [
                  {
                    index: 0,
                    type: 'Application',
                    rect: { x: 0, y: 0, width: 393, height: 852 },
                  },
                ],
              },
            }
          : { ok: true, data: {} };
      },
      dependencies: makeDependencies(clock),
      platform: 'ios',
    });

    await port.execute({
      command,
      generation: 0,
      env: {},
      invalidateObservation() {},
    });
    await port.execute({
      command: {
        kind: 'swipe',
        source: { line: 3 },
        gesture: {
          kind: 'coordinates',
          start: { space: 'absolute', x: 350, y: 400 },
          end: { space: 'absolute', x: 40, y: 400 },
          duration: 100,
        },
      },
      generation: 1,
      env: {},
      invalidateObservation() {},
    });

    expect(requests.map(({ command: requestCommand }) => requestCommand)).toEqual([
      'click',
      'snapshot',
      'snapshot',
      'gesture',
    ]);
    expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
  },
);

test('preserves mutation ordering after a failed dispatch is continued', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  let swipeAttempts = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'gesture' && swipeAttempts++ === 0) {
        throw new Error('dispatch failed after delivery became possible');
      }
      return request.command === 'snapshot'
        ? {
            ok: true,
            data: {
              nodes: [
                {
                  index: 0,
                  type: 'Application',
                  rect: { x: 0, y: 0, width: 393, height: 852 },
                },
              ],
            },
          }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });
  const swipe = (generation: number) =>
    port.execute({
      command: {
        kind: 'swipe',
        source: { line: generation + 2 },
        gesture: {
          kind: 'coordinates',
          start: { space: 'absolute', x: 350, y: 400 },
          end: { space: 'absolute', x: 40, y: 400 },
          duration: 100,
        },
      },
      generation,
      env: {},
      invalidateObservation() {},
    });

  await expect(swipe(0)).rejects.toThrow('dispatch failed');
  await swipe(1);

  expect(requests.map(({ command }) => command)).toEqual([
    'gesture',
    'snapshot',
    'snapshot',
    'gesture',
  ]);
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});

test('defers a pending mutation boundary across non-mutating runtime commands', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return request.command === 'snapshot'
        ? {
            ok: true,
            data: {
              nodes: [
                {
                  index: 0,
                  type: 'Application',
                  rect: { x: 0, y: 0, width: 393, height: 852 },
                },
              ],
            },
          }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });
  const swipe = (generation: number) =>
    port.execute({
      command: {
        kind: 'swipe',
        source: { line: generation + 2 },
        gesture: {
          kind: 'coordinates',
          start: { space: 'absolute', x: 350, y: 400 },
          end: { space: 'absolute', x: 40, y: 400 },
          duration: 100,
        },
      },
      generation,
      env: {},
      invalidateObservation() {},
    });

  await swipe(0);
  await port.execute({
    command: { kind: 'takeScreenshot', source: { line: 3 }, path: 'state.png' },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });
  expect(requests.map(({ command }) => command)).toEqual(['gesture', 'screenshot']);

  await swipe(1);
  expect(requests.map(({ command }) => command)).toEqual([
    'gesture',
    'screenshot',
    'snapshot',
    'snapshot',
    'gesture',
  ]);
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});
