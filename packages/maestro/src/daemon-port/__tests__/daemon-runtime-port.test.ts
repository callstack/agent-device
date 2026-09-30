import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import { executeMaestroFlow, inspectMaestroFlow } from '@agent-device/maestro';
import type { MaestroDaemonOperationInvoke } from '../daemon-runtime-port-support.ts';
import type { MaestroDaemonOperationRequest } from '../daemon-runtime-public-operation.ts';
import { PNG } from '@agent-device/capture-kit/png';
import {
  emitDiagnostic,
  flushDiagnosticsToSessionFile,
  withDiagnosticsScope,
} from '@agent-device/host-kit/diagnostics';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { MAESTRO_OBSERVATION_POLL_MS } from '../daemon-runtime-port-observation.ts';
import {
  makeRuntimeEnvelope,
  makeDependencies,
  makeSnapshot,
  noMaestroIncludeSources,
} from './daemon-runtime-port-fixtures.ts';
import { mkdtempForTestSync } from '../../tmp-dir.fixtures.ts';
import { formatRole } from '@agent-device/kernel/snapshot';
import { AppError } from '@agent-device/kernel/errors';
import {
  assertDispatchDisclosureDriversMatchRows,
  DISPATCH_DISCLOSURE_TABLE_PATH,
  dispatchDisclosureRowsOwnedBy,
} from '@agent-device/contracts/dispatch-disclosure-fixtures';

test('registers Maestro inputText as sensitive before nested platform work', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-input-diagnostics-');
  const logPath = path.join(root, 'request.ndjson');
  const text = 'opaque-maestro-input';
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      if (request.command === 'type') {
        emitDiagnostic({
          phase: 'platform_echo',
          data: { message: `Backend echoed ${request.positionals?.[0]}` },
        });
      }
      return request.command === 'snapshot'
        ? { ok: true, data: { nodes: [], createdAt: 0 } }
        : { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await withDiagnosticsScope({ command: 'replay', logPath }, async () => {
    await port.execute({
      command: { kind: 'inputText', source: { line: 2 }, text },
      generation: 0,
      env: {},
      invalidateObservation() {},
    });
    flushDiagnosticsToSessionFile({ force: true });
  });

  const diagnostics = fs.readFileSync(logPath, 'utf8');
  expect(diagnostics).not.toContain(text);
  expect(diagnostics).toContain('Backend echoed [REDACTED]');
});

test('delegates lifecycle and coordinate gestures through public daemon commands', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const invoke: MaestroDaemonOperationInvoke = async (request) => {
    requests.push(request);
    return request.command === 'snapshot'
      ? {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                type: 'Application',
                kind: formatRole('Application'),
                rect: { x: 0, y: 0, width: 393, height: 852 },
              },
            ],
          },
        }
      : { ok: true, data: {} };
  };
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
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

test('projects standalone clearState to settings without opening the app', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const invoke: MaestroDaemonOperationInvoke = async (request) => {
    requests.push(request);
    return { ok: true, data: {} };
  };
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'android',
  });

  await port.execute({
    command: { kind: 'clearState', source: { line: 2 }, appId: 'com.example.app' },
    generation: 0,
    env: {},
    invalidateObservation() {},
  });
  await port.execute({
    command: { kind: 'clearState', source: { line: 3 } },
    generation: 1,
    env: {},
    appId: 'com.example.session',
    invalidateObservation() {},
  });

  expect(requests).toEqual([
    expect.objectContaining({
      command: 'settings',
      positionals: ['clear-app-state', 'com.example.app'],
    }),
    expect.objectContaining({
      command: 'settings',
      positionals: ['clear-app-state', 'com.example.session'],
    }),
  ]);
});

test('uses the direct viewport without snapshot and pairs it with the nested gesture request', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const viewport = { x: 10, y: 20, width: 400, height: 800 };
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'snapshot') throw new Error('gesture viewport must not snapshot');
      if (request.command === 'runtime') return { ok: true, data: { viewport } };
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(),
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
    dispatch: {
      gestureExecutionProfile: 'endpoint-hold',
      gestureViewport: viewport,
    },
  });
  expect(requests.map(({ command }) => command)).toEqual(['runtime', 'gesture']);
});

test('uses an observation as the baseline for a later mutation barrier', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const clock = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
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
    settleLatches: 1,
    settleTimeouts: 0,
  });
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
});

test('settles a gesture before dispatching another gesture', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const clock = { value: 0 };
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
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

test('carries the runtime envelope flags into every projected operation', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({
      flags: {
        platform: 'android',
        target: 'mobile',
        noRecord: true,
      },
    }),
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
                  kind: formatRole('Application'),
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
    flags: {
      platform: 'android',
      target: 'mobile',
      noRecord: true,
      relaunch: true,
    },
  });
  for (const request of requests.slice(1)) {
    expect(request).toMatchObject({
      flags: {
        platform: 'android',
        target: 'mobile',
        noRecord: true,
      },
    });
  }
});

test('preserves native Enter dispatch failures', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
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
  const requests: MaestroDaemonOperationRequest[] = [];
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
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
  const root = mkdtempForTestSync('agent-device-maestro-daemon-port-');
  const sourcePath = path.join(root, 'flow.yaml');
  fs.writeFileSync(sourcePath, '---\n- runScript: setup.js\n');
  fs.writeFileSync(path.join(root, 'setup.js'), 'output.token = PREFIX + "-ready";\n');
  const invoke: MaestroDaemonOperationInvoke = async (request) => {
    if (request.command === 'snapshot') {
      return {
        ok: true,
        data: {
          createdAt: 0,
          nodes: [
            {
              index: 0,
              type: 'Application',
              kind: formatRole('Application'),
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
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
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
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
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
              kind: formatRole('Application'),
              rect: { x: 0, y: 0, width: 402, height: 874 },
            },
            ...(now.value < 500
              ? []
              : [
                  {
                    index: 1,
                    parentIndex: 0,
                    type: 'Text',
                    kind: formatRole('Text'),
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
  const requests: MaestroDaemonOperationRequest[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'android', replayBackend: 'maestro' } }),
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

  const result = await port.execute({
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
  expect(result).not.toHaveProperty('visualStabilityReached');
});

test('waitForAnimationToEnd uses the persistent runner capture backend on iOS', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
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
  const requests: MaestroDaemonOperationRequest[] = [];
  const screenshot = PNG.sync.write(new PNG({ width: 1, height: 1 }));
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      kind: formatRole('Button'),
      identifier: 'settings',
      label: 'Settings',
      rect: { x: 20, y: 40, width: 120, height: 44 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'Button',
      kind: formatRole('Button'),
      identifier: 'catalog',
      label: 'Catalog',
      rect: { x: 20, y: 100, width: 120, height: 44 },
    },
  ]);

  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
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

  const flow = inspectMaestroFlow(
    [
      'appId: com.callstack.agentdevicelab',
      '---',
      '- tapOn:',
      '    text: Settings',
      '- waitForAnimationToEnd: 0',
      '- tapOn:',
      '    text: Catalog',
    ].join('\n'),
    '/flows/settled.yaml',
  );

  const result = await executeMaestroFlow(flow, port, { readSource: noMaestroIncludeSources });

  expect(result).toMatchObject({ ok: true, replayed: 3 });
  expect(requests.map(({ command }) => command)).toEqual([
    'snapshot',
    'click',
    'screenshot',
    'screenshot',
    'snapshot',
    'click',
  ]);
});

test('timed-out waitForAnimationToEnd retains the pending hierarchy settle', async () => {
  const requests: MaestroDaemonOperationRequest[] = [];
  const clock = { value: 0 };
  const firstScreenshot = new PNG({ width: 1, height: 1 });
  firstScreenshot.data[3] = 255;
  const secondScreenshot = new PNG({ width: 1, height: 1 });
  secondScreenshot.data[0] = 255;
  secondScreenshot.data[3] = 255;
  const screenshots = [PNG.sync.write(firstScreenshot), PNG.sync.write(secondScreenshot)];
  let screenshotIndex = 0;
  const snapshot = makeSnapshot([
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      kind: formatRole('Button'),
      identifier: 'settings',
      label: 'Settings',
      rect: { x: 20, y: 40, width: 120, height: 44 },
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'Button',
      kind: formatRole('Button'),
      identifier: 'catalog',
      label: 'Catalog',
      rect: { x: 20, y: 100, width: 120, height: 44 },
    },
  ]);

  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke: async (request) => {
      requests.push(request);
      if (request.command === 'snapshot') return { ok: true, data: snapshot };
      if (request.command === 'screenshot') {
        await fs.promises.writeFile(
          request.positionals[0]!,
          screenshots[screenshotIndex++ % screenshots.length]!,
        );
      }
      return { ok: true, data: {} };
    },
    dependencies: makeDependencies(clock),
    platform: 'ios',
  });

  const flow = inspectMaestroFlow(
    [
      'appId: com.callstack.agentdevicelab',
      '---',
      '- tapOn:',
      '    text: Settings',
      '- waitForAnimationToEnd: 0',
      '- tapOn:',
      '    text: Catalog',
    ].join('\n'),
    '/flows/timed-out.yaml',
  );

  const result = await executeMaestroFlow(flow, port, { readSource: noMaestroIncludeSources });

  expect(result).toMatchObject({ ok: true, replayed: 3 });
  expect(clock.value).toBe(MAESTRO_OBSERVATION_POLL_MS);
  expect(requests.map(({ command }) => command)).toEqual([
    'snapshot',
    'click',
    'screenshot',
    'screenshot',
    'snapshot',
    'click',
  ]);
});

// contracts/fixtures/dispatch-disclosure.json, maestro-port rows: each drives one Maestro command
// through the real port with only the daemon invoke faked.

const RUNNER_BUSY_SNAPSHOT_REFUSAL = {
  ok: false,
  error: {
    code: 'COMMAND_FAILED',
    message: 'runner busy',
    details: {
      reason: 'runner_busy',
      runnerErrorCode: 'RUNNER_BUSY',
      retriable: true,
      dispatched: 'no',
    },
  },
} as const;

const DISCOVER_OFFSCREEN_SNAPSHOT = {
  ok: true,
  data: {
    createdAt: 0,
    nodes: [
      { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 402, height: 874 } },
      {
        index: 1,
        parentIndex: 0,
        type: 'Text',
        label: 'Discover',
        rect: { x: 20, y: 900, width: 120, height: 48 },
      },
    ],
  },
} as const;

async function executeWithInvoke(
  command: Parameters<ReturnType<typeof createDaemonMaestroRuntimePort>['execute']>[0]['command'],
  invoke: MaestroDaemonOperationInvoke,
): Promise<unknown> {
  const port = createDaemonMaestroRuntimePort({
    ...makeRuntimeEnvelope({ flags: { platform: 'ios', replayBackend: 'maestro' } }),
    invoke,
    dependencies: makeDependencies(),
    platform: 'ios',
  });
  return await port.execute({ command, generation: 0, env: {}, invalidateObservation() {} });
}

const SCROLL_UNTIL_DISCOVER = {
  kind: 'scrollUntilVisible',
  source: { line: 2 },
  element: { text: 'Discover' },
  direction: 'up',
  timeout: 2_000,
} as const;

async function scrollUntilWithCaptureRefusedAfterScroll(): Promise<unknown> {
  const commands: string[] = [];
  try {
    return await executeWithInvoke(SCROLL_UNTIL_DISCOVER, async (request) => {
      commands.push(request.command);
      if (request.command !== 'snapshot') return { ok: true, data: {} };
      return commands.includes('scroll')
        ? RUNNER_BUSY_SNAPSHOT_REFUSAL
        : DISCOVER_OFFSCREEN_SNAPSHOT;
    });
  } finally {
    expect(commands.filter((command) => command === 'scroll')).toHaveLength(1);
  }
}

async function scrollUntilWithFirstCaptureRefused(): Promise<unknown> {
  const commands: string[] = [];
  try {
    return await executeWithInvoke(SCROLL_UNTIL_DISCOVER, async (request) => {
      commands.push(request.command);
      return request.command === 'snapshot' ? RUNNER_BUSY_SNAPSHOT_REFUSAL : { ok: true, data: {} };
    });
  } finally {
    expect(commands).not.toContain('scroll');
  }
}

async function inputTextWithSettleCaptureRefused(): Promise<unknown> {
  const commands: string[] = [];
  try {
    return await executeWithInvoke(
      { kind: 'inputText', source: { line: 2 }, text: 'hello' },
      async (request) => {
        commands.push(request.command);
        return request.command === 'snapshot'
          ? RUNNER_BUSY_SNAPSHOT_REFUSAL
          : { ok: true, data: {} };
      },
    );
  } finally {
    expect(commands[0]).toBe('type');
  }
}

const DRIVERS: Record<string, () => Promise<unknown>> = {
  'maestro-port.scroll-until.capture-after-scroll-refused':
    scrollUntilWithCaptureRefusedAfterScroll,
  'maestro-port.input-text.settle-capture-refused': inputTextWithSettleCaptureRefused,
  'maestro-port.scroll-until.first-capture-refused': scrollUntilWithFirstCaptureRefused,
};

const ROWS = dispatchDisclosureRowsOwnedBy(
  import.meta.url,
  fs.readFileSync(DISPATCH_DISCLOSURE_TABLE_PATH, 'utf8'),
);

test('every maestro-port dispatch-disclosure row has exactly one driver', () => {
  assertDispatchDisclosureDriversMatchRows(ROWS, Object.keys(DRIVERS));
});

for (const row of ROWS) {
  test(`${row.id}: ${row.trigger} → dispatched ${row.dispatched}`, async () => {
    const drive = DRIVERS[row.id];
    expect(drive, `no driver for ${row.id}`).toBeDefined();
    const failure = await drive!().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AppError);
    const details = (failure as AppError).details;
    expect(details?.dispatched).toBe(row.dispatched);
    expect(details?.dispatchedSteps).toBe(row.dispatched === 'unknown' ? 1 : undefined);
  });
}
