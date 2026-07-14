import { expect, test } from 'vitest';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import {
  MAESTRO_INITIAL_SNAPSHOT_READY_TIMEOUT_MS,
  MAESTRO_OBSERVATION_POLL_MS,
} from '../daemon-runtime-port-observation.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('does not pair an observation with a later same-generation snapshot', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      const targetX = snapshots >= 4 ? 40 : 200;
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
              identifier: 'ready',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
            {
              index: 2,
              parentIndex: 0,
              type: 'Button',
              identifier: 'continue',
              rect: { x: targetX, y: 100, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  const observation = await port.observe({
    condition: { kind: 'visible', selector: { id: 'ready' } },
    timeoutMs: 0,
    generation: 0,
    env: {},
  });
  await port.execute({
    command: { kind: 'waitForAnimationToEnd', source: { line: 2 }, timeout: 500 },
    generation: 0,
    cachedObservation: observation,
    env: {},
    invalidateObservation() {},
  });
  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 3 },
      target: { space: 'target', selector: { id: 'continue' } },
    },
    generation: 0,
    cachedObservation: observation,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map((request) => request.command)).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
    'snapshot',
    'click',
  ]);
  expect(requests.at(-1)?.positionals).toEqual(['id="continue"']);
});

test('retries typed transient snapshot failures within the observation budget', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      if (snapshots === 1) {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'Foreground app window is transitioning.',
            retriable: true,
          },
        };
      }
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [
            {
              index: 0,
              type: 'Text',
              identifier: 'ready',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(clock),
    platform: 'android',
  });

  const observation = await port.observe({
    condition: { kind: 'visible', selector: { id: 'ready' } },
    timeoutMs: 500,
    generation: 0,
    env: {},
  });

  expect(observation.matched).toBe(true);
  expect(requests.map((request) => request.command)).toEqual(['snapshot', 'snapshot']);
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});

test('starts the selector timeout after the first valid snapshot', async () => {
  const clock = { value: 0 };
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      if (snapshots <= 3) {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: 'Foreground app window is transitioning.',
            retriable: true,
          },
        };
      }
      return {
        ok: true,
        data: {
          createdAt: snapshots,
          nodes: [
            {
              index: 0,
              type: 'Text',
              identifier: 'ready',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(clock),
    platform: 'android',
  });

  await expect(
    port.observe({
      condition: { kind: 'visible', selector: { id: 'ready' } },
      timeoutMs: 500,
      generation: 0,
      env: {},
    }),
  ).resolves.toMatchObject({ matched: true });
  expect(clock.value).toBe(3 * MAESTRO_OBSERVATION_POLL_MS);
});

test('bounds initial typed snapshot recovery independently of selector matching', async () => {
  const clock = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async () => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'Foreground app window is transitioning.',
        retriable: true,
      },
    }),
    dependencies: makeDependencies(clock),
    platform: 'android',
  });

  await expect(
    port.observe({
      condition: { kind: 'visible', selector: { id: 'ready' } },
      timeoutMs: 500,
      generation: 0,
      env: {},
    }),
  ).rejects.toMatchObject({ message: 'Foreground app window is transitioning.' });
  expect(clock.value).toBe(MAESTRO_INITIAL_SNAPSHOT_READY_TIMEOUT_MS);
});

test('does not retry deterministic snapshot failures', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return {
        ok: false,
        error: {
          code: 'COMMAND_FAILED',
          message: 'Android snapshot helper is unavailable.',
        },
      };
    },
    dependencies: makeDependencies(clock),
    platform: 'android',
  });

  await expect(
    port.observe({
      condition: { kind: 'visible', selector: { id: 'ready' } },
      timeoutMs: 500,
      generation: 0,
      env: {},
    }),
  ).rejects.toMatchObject({ message: 'Android snapshot helper is unavailable.' });
  expect(requests.map((request) => request.command)).toEqual(['snapshot']);
  expect(clock.value).toBe(0);
});

test('fails scrollUntilVisible when the target stays absent', async () => {
  const invoke: DaemonInvokeFn = async (request) =>
    request.command === 'snapshot'
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
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
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
});

test.each([
  [{ kind: 'inputText', source: { line: 2 }, text: 'hello' }, 'hello'],
  [{ kind: 'eraseText', source: { line: 2 }, charactersToErase: 3 }, '\b\b\b'],
  [{ kind: 'pasteText', source: { line: 2 }, text: 'pasted' }, 'pasted'],
] as const)('waits for a stable snapshot after a Maestro $kind mutation', async (command, text) => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
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
              type: 'TextField',
              value: snapshots === 1 ? 'pending' : 'committed',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({ command, generation: 0, env: {}, invalidateObservation() {} });

  expect(requests.map((request) => request.command)).toEqual([
    'type',
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
  expect(requests[0]?.positionals).toEqual([text]);
});

test('commits Maestro input text before dispatching an immediate tap', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  let textCommitted = false;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'click') {
        if (!textCommitted) throw new Error('tap raced the text commit');
        return { ok: true, data: {} };
      }
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      textCommitted = snapshots >= 2;
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
              type: 'Button',
              identifier: 'navigate',
              rect: { x: 20, y: 40, width: 120, height: 44 },
            },
            {
              index: 2,
              parentIndex: 0,
              type: 'TextField',
              value: textCommitted ? 'hello' : '',
              rect: { x: 20, y: 100, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({
    command: { kind: 'inputText', source: { line: 2 }, text: 'hello' },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 3 },
      target: { space: 'target', selector: { id: 'navigate' } },
    },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map((request) => request.command)).toEqual([
    'type',
    'snapshot',
    'snapshot',
    'snapshot',
    'snapshot',
    'click',
  ]);
});
