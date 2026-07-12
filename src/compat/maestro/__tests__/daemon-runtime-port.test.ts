import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { DaemonInvokeFn, DaemonRequest } from '../../../daemon/types.ts';
import { createDaemonMaestroRuntimePort } from '../daemon-runtime-port.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('delegates lifecycle and coordinate gestures through public daemon commands', async () => {
  const requests: DaemonRequest[] = [];
  const invoke: DaemonInvokeFn = async (request) => {
    requests.push(request);
    return { ok: true, data: {} };
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
    expect.objectContaining({
      command: 'swipe',
      positionals: [],
      input: {
        from: { x: 360, y: 400 },
        to: { x: 40, y: 400 },
        durationMs: 240,
      },
    }),
  ]);
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
    }),
  ).resolves.toMatchObject({ outputEnv: { 'output.token': 'typed-ready' } });
  await expect(
    port.execute({
      command: { kind: 'takeScreenshot', source: { line: 3 }, path: 'shot.png' },
      generation: 0,
      env: { PREFIX: 'typed' },
    }),
  ).resolves.toMatchObject({ artifactPaths: [path.join(root, 'shot.png')] });
});
