import { expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { PNG } from '../../../utils/png.ts';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('waits for a delayed input target using fresh snapshots', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  const invoke: DaemonInvokeFn = async (request) => {
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
          ...(snapshots < 3
            ? []
            : [
                {
                  index: 1,
                  parentIndex: 0,
                  type: 'Button',
                  identifier: 'delayedButton',
                  rect: { x: 20, y: 40, width: 120, height: 44 },
                },
              ]),
        ],
      },
    };
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await expect(
    port.execute({
      command: {
        kind: 'tapOn',
        source: { line: 2 },
        target: { space: 'target', selector: { id: 'delayedButton' } },
      },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).resolves.toEqual({});
  expect(requests.map((request) => request.command)).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
    'click',
  ]);
  expect(
    requests.filter(({ command }) => command === 'click').map(({ positionals }) => positionals),
  ).toEqual([['80', '62']]);
});

test('atomically dispatches a unique exact iOS target from same-generation evidence', async () => {
  const requests: DaemonRequest[] = [];
  let snapshots = 0;
  let clicked = false;
  const invoke: DaemonInvokeFn = async (request) => {
    requests.push(request);
    if (request.command !== 'snapshot') {
      clicked = true;
      return { ok: true, data: {} };
    }
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
            identifier: 'ready',
            rect: { x: 20, y: 40, width: 120, height: 44 },
          },
          ...(clicked
            ? [
                {
                  index: 2,
                  parentIndex: 0,
                  type: 'Text',
                  identifier: 'done',
                  rect: { x: 20, y: 100, width: 120, height: 44 },
                },
              ]
            : [
                {
                  index: 2,
                  parentIndex: 0,
                  type: 'Button',
                  identifier: 'continue',
                  rect: { x: snapshots === 1 ? 20 : 160, y: 100, width: 120, height: 44 },
                },
              ]),
        ],
      },
    };
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  const observation = await port.observe({
    condition: { kind: 'visible', selector: { id: 'ready' } },
    timeoutMs: 0,
    generation: 0,
    env: {},
  });
  await expect(
    port.execute({
      command: {
        kind: 'tapOn',
        source: { line: 2 },
        target: { space: 'target', selector: { id: 'continue' } },
      },
      generation: 0,
      cachedObservation: { ...observation },
      env: {},
      invalidateObservation() {},
    }),
  ).resolves.toEqual({});

  expect(requests.map((request) => request.command)).toEqual(['snapshot', 'click']);
  expect(observation.identity).toBeDefined();
  const click = requests.find((request) => request.command === 'click');
  expect(click?.positionals).toEqual(['id="continue"']);
  expect(click?.flags?.maestro).toEqual({
    allowNonHittableCoordinateFallback: true,
    expectedTapPoint: { x: 80, y: 122 },
  });
});

test('retries an iOS non-hittable coordinate fallback when the hierarchy does not change', async () => {
  const requests: DaemonRequest[] = [];
  let clicks = 0;
  const screenshot = solidPng(0);
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'click') {
        clicks += 1;
        return {
          ok: true,
          data: { maestroNonHittableCoordinateFallbackUsed: true },
        };
      }
      if (request.command === 'screenshot') {
        await fs.writeFile(request.positionals[0]!, screenshot);
        return { ok: true, data: {} };
      }
      return {
        ok: true,
        data: {
          createdAt: clicks,
          nodes: [
            { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
            ...(clicks < 2
              ? [
                  {
                    index: 1,
                    parentIndex: 0,
                    type: 'Button',
                    label: 'Pop to top',
                    rect: { x: 142, y: 110, width: 116, height: 40 },
                  },
                ]
              : [
                  {
                    index: 1,
                    parentIndex: 0,
                    type: 'Button',
                    label: 'Push Article',
                    rect: { x: 16, y: 110, width: 120, height: 40 },
                  },
                ]),
          ],
        },
      };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'Pop to top' } },
      retryTapIfNoChange: true,
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual([
    'snapshot',
    'screenshot',
    'click',
    'snapshot',
    'snapshot',
    'screenshot',
    'click',
    'snapshot',
    'snapshot',
  ]);
  expect(clicks).toBe(2);
  expect(port.readMetrics?.()).toEqual({
    hierarchyCaptures: 5,
    screenshotCaptures: 2,
    tapRetries: 1,
  });
});

test('does not retry an iOS tap when only the rendered surface changes', async () => {
  const requests: DaemonRequest[] = [];
  let clicks = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'click') {
        clicks += 1;
        return { ok: true, data: {} };
      }
      if (request.command === 'screenshot') {
        await fs.writeFile(request.positionals[0]!, solidPng(clicks === 0 ? 0 : 255));
        return { ok: true, data: {} };
      }
      return {
        ok: true,
        data: {
          nodes: [
            { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 393, height: 852 } },
            {
              index: 1,
              parentIndex: 0,
              type: 'Button',
              label: 'Toggle canvas',
              rect: { x: 142, y: 110, width: 116, height: 40 },
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
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'target', selector: { text: 'Toggle canvas' } },
      retryTapIfNoChange: true,
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual([
    'snapshot',
    'screenshot',
    'click',
    'snapshot',
    'snapshot',
    'screenshot',
  ]);
  expect(clicks).toBe(1);
  expect(port.readMetrics?.()).toEqual({
    hierarchyCaptures: 3,
    screenshotCaptures: 2,
    tapRetries: 0,
  });
});

test('uses screenshot evidence without a redundant hierarchy baseline for iOS point taps', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'screenshot') {
        await fs.writeFile(request.positionals[0]!, solidPng(0));
      }
      return request.command === 'snapshot'
        ? { ok: true, data: { nodes: [{ index: 0, type: 'Application' }] } }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'tapOn',
      source: { line: 2 },
      target: { space: 'absolute', x: 120, y: 240 },
      retryTapIfNoChange: true,
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual([
    'screenshot',
    'click',
    'snapshot',
    'snapshot',
    'screenshot',
    'click',
    'snapshot',
    'snapshot',
  ]);
  expect(port.readMetrics?.()).toEqual({
    hierarchyCaptures: 4,
    screenshotCaptures: 2,
    tapRetries: 1,
  });
});

function solidPng(value: number): Buffer {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(value);
  return PNG.sync.write(image);
}
