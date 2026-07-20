import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import { PNG } from '../../../utils/png.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { MAESTRO_OBSERVATION_POLL_MS } from '../daemon-runtime-port-observation.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { executeMaestroProgram } from './runtime-port-fixtures.ts';
import { makeBaseRequest, makeDependencies, makeSnapshot } from './daemon-runtime-port-fixtures.ts';

test('delegates lifecycle and coordinate gestures through public daemon commands', async () => {
  const requests: DaemonRequest[] = [];
  const invoke: DaemonInvokeFn = async (request) => {
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
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({
    command: {
      kind: 'launchApp',
      source: { line: 2 },
      appId: 'com.example.app',
      clearState: true,
      launchArguments: { kind: 'map', values: { seed: 7 } },
    },
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
        start: { space: 'absolute', x: 360, y: 400 },
        end: { space: 'absolute', x: 40, y: 400 },
        duration: 240,
      },
    },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });

  expect(requests).toEqual([
    expect.objectContaining({
      command: 'open',
      positionals: ['com.example.app'],
      flags: expect.objectContaining({
        clearAppState: true,
        launchArgs: ['seed', '7'],
      }),
    }),
    expect.objectContaining({ command: 'snapshot' }),
    expect.objectContaining({ command: 'snapshot' }),
    expect.objectContaining({
      command: 'gesture',
      positionals: [],
      input: {
        kind: 'pan',
        origin: { x: 360, y: 400 },
        delta: { x: -320, y: 0 },
        durationMs: 240,
      },
    }),
  ]);
});

test('uses the direct viewport without snapshot and pairs it with the nested gesture request', async () => {
  const requests: DaemonRequest[] = [];
  const viewport = { x: 10, y: 20, width: 400, height: 800 };
  const resolveGestureViewport = vi.fn(async () => viewport);
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'snapshot') throw new Error('gesture viewport must not snapshot');
      return { ok: true, data: {} };
    },
    dependencies: { ...makeDependencies(), resolveGestureViewport },
    platform: 'android',
  });

  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 3 },
      gesture: {
        kind: 'coordinates',
        start: { space: 'percent', x: 90, y: 50 },
        end: { space: 'percent', x: 10, y: 50 },
        duration: 300,
      },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.at(-1)).toMatchObject({
    command: 'gesture',
    input: {
      kind: 'pan',
      origin: { x: 370, y: 420 },
      delta: { x: -320, y: 0 },
      durationMs: 300,
    },
    internal: {
      gestureExecutionProfile: 'endpoint-hold',
      gestureViewport: viewport,
    },
  });
  expect(resolveGestureViewport).toHaveBeenCalledOnce();
  expect(requests.map(({ command }) => command)).toEqual(['gesture']);
});

test('uses an observation as the baseline for a later mutation barrier', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      return {
        ok: true,
        data: {
          nodes: [
            {
              index: 0,
              identifier: 'pageNumber2',
              rect: { x: 20, y: 100, width: 120, height: 44 },
            },
          ],
        },
      };
    },
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });

  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 2 },
      gesture: {
        kind: 'coordinates',
        start: { space: 'absolute', x: 360, y: 400 },
        end: { space: 'absolute', x: 40, y: 400 },
        duration: 100,
      },
    },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  const observation = await port.observe({
    condition: { kind: 'visible', selector: { id: 'pageNumber2' } },
    timeoutMs: 500,
    generation: 1,
    env: {},
  });
  await port.execute({
    command: {
      kind: 'swipe',
      source: { line: 3 },
      gesture: {
        kind: 'coordinates',
        start: { space: 'absolute', x: 360, y: 400 },
        end: { space: 'absolute', x: 40, y: 400 },
        duration: 100,
      },
    },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });

  expect(observation).toMatchObject({ matched: true });
  expect(requests.map(({ command }) => command)).toEqual([
    'gesture',
    'snapshot',
    'snapshot',
    'gesture',
  ]);
  expect(port.readMetrics?.()).toEqual({
    hierarchyCaptures: 2,
    screenshotCaptures: 0,
    tapRetries: 0,
  });
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});

test('settles a gesture before dispatching another gesture', async () => {
  const requests: DaemonRequest[] = [];
  const clock = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return request.command === 'snapshot'
        ? {
            ok: true,
            data: {
              nodes: [
                {
                  index: 0,
                  identifier: 'pageNumber1',
                  rect: { x: 20, y: 100, width: 120, height: 44 },
                },
              ],
            },
          }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(clock),
    platform: 'android',
  });
  const swipe = (generation: number) =>
    port.execute({
      command: {
        kind: 'swipe',
        source: { line: generation + 2 },
        gesture: {
          kind: 'coordinates',
          start: { space: 'absolute', x: 360, y: 400 },
          end: { space: 'absolute', x: 40, y: 400 },
          duration: 100,
        },
      },
      generation,
      env: {},
      invalidateObservation() {},
    });

  await swipe(0);
  await swipe(1);

  expect(requests.map(({ command }) => command)).toEqual([
    'gesture',
    'snapshot',
    'snapshot',
    'gesture',
  ]);
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});

test('preserves the resolved nested-command request context', async () => {
  const requests: DaemonRequest[] = [];
  const baseReq = {
    ...makeBaseRequest({
      token: 'nested-token',
      session: 'maestro-nested',
      meta: {
        debug: true,
        includeCost: true,
        responseLevel: 'full',
        sessionIsolation: 'tenant',
      },
      flags: {
        platform: 'android',
        target: 'mobile',
        noRecord: true,
      },
    }),
    runtime: {
      platform: 'android' as const,
      metroHost: '127.0.0.1',
      metroPort: 8081,
      bundleUrl: 'http://127.0.0.1:8081/index.bundle',
    },
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq,
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
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({
    command: { kind: 'launchApp', source: { line: 2 }, appId: 'com.example.app' },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  await port.execute({
    command: { kind: 'back', source: { line: 3 } },
    generation: 1,
    env: {},
    invalidateObservation() {},
  });

  expect(requests).toHaveLength(4);
  expect(requests[0]).toMatchObject({
    token: 'nested-token',
    session: 'maestro-nested',
    runtime: baseReq.runtime,
    meta: baseReq.meta,
    flags: {
      platform: 'android',
      target: 'mobile',
      noRecord: true,
      relaunch: true,
    },
  });
  for (const request of requests.slice(1)) {
    expect(request).toMatchObject({
      token: 'nested-token',
      session: 'maestro-nested',
      runtime: baseReq.runtime,
      meta: baseReq.meta,
      flags: {
        platform: 'android',
        target: 'mobile',
        noRecord: true,
      },
    });
  }
});

test('preserves native Enter dispatch failures', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return request.command === 'keyboard'
        ? {
            ok: false,
            error: { code: 'UNSUPPORTED_OPERATION', message: 'Key dispatch is unsupported.' },
          }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await expect(
    port.execute({
      command: { kind: 'pressKey', source: { line: 2 }, key: 'enter' },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).rejects.toMatchObject({ code: 'UNSUPPORTED_OPERATION' });

  expect(requests.map(({ command }) => command)).toEqual(['keyboard']);
});

test('does not repeat Enter after an ambiguous keyboard failure', async () => {
  const requests: DaemonRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      return {
        ok: false,
        error: { code: 'COMMAND_FAILED', message: 'Keyboard dispatch timed out.' },
      };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await expect(
    port.execute({
      command: { kind: 'pressKey', source: { line: 2 }, key: 'enter' },
      generation: 0,
      env: {},
      invalidateObservation() {},
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
  expect(requests.map(({ command }) => command)).toEqual(['keyboard']);
});

test('keeps absent negative observations, script output, and artifacts typed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-daemon-port-'));
  const sourcePath = path.join(root, 'flow.yaml');
  fs.writeFileSync(sourcePath, '---\n- runScript: setup.js\n');
  fs.writeFileSync(path.join(root, 'setup.js'), 'output.token = PREFIX + "-ready";\n');
  const invoke: DaemonInvokeFn = async (request) => {
    if (request.command === 'snapshot') {
      return {
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
      };
    }
    if (request.command === 'screenshot') {
      return { ok: true, data: { path: path.join(root, 'shot.png') } };
    }
    return { ok: true, data: {} };
  };
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'ios',
    sourcePath,
  });

  await expect(
    port.observe({
      condition: { kind: 'notVisible', selector: { id: 'loading' } },
      timeoutMs: 0,
      generation: 0,
      env: { PREFIX: 'typed' },
    }),
  ).resolves.toMatchObject({ matched: true, candidateCount: 0 });
  await expect(
    port.execute({
      command: { kind: 'runScript', source: { path: sourcePath, line: 2 }, file: 'setup.js' },
      generation: 0,
      env: { PREFIX: 'typed' },
      invalidateObservation() {},
    }),
  ).resolves.toMatchObject({ outputEnv: { 'output.token': 'typed-ready' } });
  await expect(
    port.execute({
      command: { kind: 'takeScreenshot', source: { line: 3 }, path: 'shot.png' },
      generation: 0,
      env: { PREFIX: 'typed' },
      invalidateObservation() {},
    }),
  ).resolves.toMatchObject({ artifactPaths: [path.join(root, 'shot.png')] });
});

test('takes one final observation when polling wakes after the deadline', async () => {
  const now = { value: 0 };
  let snapshots = 0;
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      snapshots += 1;
      return {
        ok: true,
        data: {
          createdAt: now.value,
          nodes: [
            {
              index: 0,
              type: 'Application',
              rect: { x: 0, y: 0, width: 402, height: 874 },
            },
            ...(now.value < 500
              ? []
              : [
                  {
                    index: 1,
                    parentIndex: 0,
                    type: 'Text',
                    identifier: 'ready',
                    rect: { x: 20, y: 40, width: 120, height: 44 },
                  },
                ]),
          ],
        },
      };
    },
    dependencies: {
      now: () => now.value,
      sleep: async (milliseconds) => {
        now.value += milliseconds + 1;
      },
      resolveGestureViewport: async () => ({ x: 0, y: 0, width: 402, height: 874 }),
    },
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
  expect(snapshots).toBe(Math.ceil(500 / MAESTRO_OBSERVATION_POLL_MS) + 1);
});

test('waitForAnimationToEnd uses two unstabilized screenshot captures', async () => {
  const requests: DaemonRequest[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'screenshot') {
        await fs.promises.writeFile(request.positionals[0]!, screenshot);
      }
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({
    command: { kind: 'waitForAnimationToEnd', source: { line: 2 }, timeout: 0 },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests.map(({ command }) => command)).toEqual(['screenshot', 'screenshot']);
  expect(requests.every(({ flags }) => flags?.screenshotNoStabilize === true)).toBe(true);
  expect(
    requests.every(({ flags }) => flags?.maestro?.screenshotCaptureBackend === undefined),
  ).toBe(true);
});

test('waitForAnimationToEnd uses the persistent runner capture backend on iOS', async () => {
  const requests: DaemonRequest[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'screenshot') {
        await fs.promises.writeFile(request.positionals[0]!, screenshot);
      }
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  await port.execute({
    command: { kind: 'waitForAnimationToEnd', source: { line: 2 }, timeout: 0 },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });

  expect(requests).toHaveLength(2);
  expect(requests.every(({ flags }) => flags?.screenshotNoStabilize === true)).toBe(true);
  expect(requests.every(({ flags }) => flags?.maestro?.screenshotCaptureBackend === 'runner')).toBe(
    true,
  );
});

test('waitForAnimationToEnd between two taps does not throw a stability-generation mismatch', async () => {
  const requests: DaemonRequest[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      identifier: 'settings',
      label: 'Settings',
      rect: { x: 20, y: 40, width: 120, height: 44 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'Button',
      identifier: 'catalog',
      label: 'Catalog',
      rect: { x: 20, y: 100, width: 120, height: 44 },
    },
  ]);

  const port = createDaemonMaestroRuntimePort({
    baseReq: makeBaseRequest({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'snapshot') return { ok: true, data: snapshot };
      if (request.command === 'screenshot') {
        await fs.promises.writeFile(request.positionals[0]!, screenshot);
      }
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'ios',
  });

  const program = parseMaestroProgram(
    [
      'appId: com.callstack.agentdevicelab',
      '---',
      '- tapOn:',
      '    text: Settings',
      '- waitForAnimationToEnd: 0',
      '- tapOn:',
      '    text: Catalog',
    ].join('\n'),
  );

  const result = await executeMaestroProgram(program, port);

  expect(result).toMatchObject({ executed: 3, skipped: 0 });
});
