import { expect, test } from 'vitest';
import type { DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { MAESTRO_OBSERVATION_POLL_MS } from '../daemon-runtime-port-observation.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

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

test('includes initial snapshot recovery in the selector timeout', async () => {
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
  expect(clock.value).toBe(500);
});

test('bounds initial typed snapshot recovery by the authored observation timeout', async () => {
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
  expect(clock.value).toBe(500);
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
