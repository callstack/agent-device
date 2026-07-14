import { beforeEach, expect, test, vi } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildTypedMaestroFailureReportProjection } from '../session-replay-maestro-failure.ts';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { SessionStore } from '../../session-store.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { baseReplayRequest as baseReq } from './session-replay-runtime.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});

test('typed Maestro failure projection is report-only and preserves authored provenance', () => {
  const command = {
    kind: 'tapOn' as const,
    source: { path: '/flows/login.yaml', line: 4 },
    target: { space: 'target' as const, selector: { id: 'save' } },
  };
  const request = baseReq({ flags: { replayBackend: 'maestro' } });
  const projection = buildTypedMaestroFailureReportProjection(
    {
      command,
      source: command.source,
      generation: 0,
      stepIndex: 1,
      stepTotal: 1,
      durationMs: 12,
      error: new Error('tap failed'),
      artifactPaths: [],
      expandedVariables: {},
    },
    request,
  );

  expect(projection.authoredCommand).toBe(command);
  expect(projection.source).toBe(command.source);
  expect(projection.progress).toEqual({ command: 'tapOn', value: 'save' });
  expect(projection.action).toEqual({
    command: 'click',
    positionals: ['save'],
    flags: request.flags,
  });
  expect(Object.keys(projection.action)).toEqual(['command', 'positionals', 'flags']);
});

test('typed Maestro failure diagnostics scrub expanded selector values', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-selector-redaction-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const flowPath = path.join(root, 'flow.yaml');
  const sentinel = 'expanded-maestro-selector-secret';
  fs.writeFileSync(
    flowPath,
    ['appId: com.example.app', '---', '- tapOn: ${TARGET}', ''].join('\n'),
  );
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Button',
      label: sentinel,
      rect: { x: 20, y: 40, width: 120, height: 44 },
      hittable: true,
    },
  ];
  mockDispatchCommand.mockResolvedValue({
    nodes,
    truncated: false,
    backend: 'xctest',
  });

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [flowPath],
      flags: { replayBackend: 'maestro', replayEnv: [`TARGET=${sentinel}`] },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'snapshot') return { ok: true, data: { nodes } };
      if (req.command === 'click') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: `tap failed for ${sentinel}`,
            hint: `Find ${sentinel}`,
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(JSON.stringify(response.error)).not.toContain(sentinel);
  const divergence = response.error.details?.divergence as {
    action: string;
    cause: { message: string; hint?: string };
    suggestions: unknown[];
  };
  expect(divergence.action).toBe('tapOn "${TARGET}"');
  expect(divergence.cause.message).toContain('<var:TARGET>');
  expect(divergence.cause.hint).toContain('<var:TARGET>');
  expect(divergence.suggestions).toEqual([]);
});

test('typed Maestro nested scopes scrub failure values after unwind and keep retry trace identity', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-nested-redaction-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const flowPath = path.join(root, 'flow.yaml');
  const tracePath = path.join(root, 'replay-timing.ndjson');
  const sentinel = 'nested-maestro-scope-secret';
  fs.writeFileSync(
    flowPath,
    [
      'appId: com.example.app',
      '---',
      '- retry:',
      '    maxRetries: 0',
      '    commands:',
      '      - runFlow:',
      '          env:',
      '            TARGET: ${SECRET}',
      '          commands:',
      '            - tapOn: ${TARGET}',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(tracePath, '');
  const nodes = [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      parentIndex: 0,
      depth: 1,
      type: 'Button',
      label: sentinel,
      rect: { x: 20, y: 40, width: 120, height: 44 },
      hittable: true,
    },
  ];

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [flowPath],
      flags: {
        replayBackend: 'maestro',
        platform: 'ios',
        replayEnv: [`SECRET=${sentinel}`],
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    tracePath,
    invoke: async (req) => {
      if (req.command === 'snapshot') return { ok: true, data: { nodes } };
      if (req.command === 'click') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: `tap failed for ${sentinel}`,
            hint: `Find ${sentinel}`,
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  expect(JSON.stringify(response)).not.toContain(sentinel);
  const events = fs
    .readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events).toEqual([
    expect.objectContaining({
      type: 'replay_action_start',
      step: 1,
      line: 3,
      command: 'retry',
    }),
    expect.objectContaining({
      type: 'replay_action_stop',
      step: 1,
      line: 3,
      command: 'retry',
      ok: false,
    }),
  ]);
});
