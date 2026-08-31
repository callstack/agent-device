import { noMaestroIncludeSources } from '../../../../__tests__/test-utils/replay-script-source.ts';
import { beforeEach, expect, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../../core/dispatch-resolve.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../core/dispatch-resolve.ts')>();
  return { ...actual, resolveTargetDevice: vi.fn() };
});
vi.mock('../../../handlers/snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));
import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import {
  executeMaestroFlow,
  inspectMaestroFlow,
  type MaestroFailedAction,
  type MaestroRuntimeCommand,
  type MaestroRuntimePort,
} from '@agent-device/maestro';
import {
  buildTypedMaestroFailureReportProjection,
  buildTypedMaestroFailureResponse,
} from '../session-replay-maestro-failure.ts';
import { runReplayForTest } from '../../__tests__/replay-command-fixture.ts';
import { SessionStore } from '../../../session-store.ts';
import { captureSnapshotWithInteractor } from '../../../handlers/snapshot-interactor-capture.ts';
import { makeIosSession } from '../../../../__tests__/test-utils/session-factories.ts';
import { baseReplayRequest as baseReq } from '../../__tests__/session-replay-runtime.fixtures.ts';
import { replaySessionForTest } from './replay-session-fixture.ts';
import type { SnapshotNode } from '@agent-device/kernel/snapshot';
import {
  captureSnapshotThroughLegacyDispatchFixture,
  legacyDispatchCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';

const mockDispatchCommand = legacyDispatchCapture;
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
  mockCaptureSnapshotWithInteractor.mockReset();
  mockCaptureSnapshotWithInteractor.mockImplementation(captureSnapshotThroughLegacyDispatchFixture);
});

async function buildFailureScenario(
  command: MaestroRuntimeCommand,
  nodes: SnapshotNode[],
): Promise<{
  response: Extract<Awaited<ReturnType<typeof buildTypedMaestroFailureResponse>>, { ok: false }>;
  sessionStore: SessionStore;
  sessionName: string;
}> {
  const root = mkdtempForTestSync('agent-device-maestro-suggestions-');
  const sessionName = 'default';
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const replaySession = replaySessionForTest(sessionStore, sessionName);
  mockDispatchCommand.mockResolvedValue({ nodes, truncated: false, backend: 'xctest' });
  const failure = await captureMaestroFailure(command, path.join(root, 'flow.yaml'));
  const response = await buildTypedMaestroFailureResponse({
    error: { code: 'COMMAND_FAILED', message: 'typed Maestro action failed' },
    failure,
    replayPath: path.join(root, 'flow.yaml'),
    req: baseReq({ flags: { replayBackend: 'maestro', platform: 'ios' } }),
    sessionName,
    sessionStore: replaySession.store,
    observationStore: replaySession.observationStore,
    logPath: path.join(root, 'daemon.log'),
  });
  if (response.ok) throw new Error('expected typed Maestro failure response');
  return { response, sessionStore, sessionName };
}

async function buildFailureResponse(
  command: MaestroRuntimeCommand,
  nodes: SnapshotNode[],
): Promise<Extract<Awaited<ReturnType<typeof buildTypedMaestroFailureResponse>>, { ok: false }>> {
  return (await buildFailureScenario(command, nodes)).response;
}

test('typed Maestro failure projection keeps action and source provenance', async () => {
  const command = {
    kind: 'tapOn' as const,
    source: { path: '/flows/login.yaml', line: 4 },
    target: { space: 'target' as const, selector: { id: 'save' } },
  };
  const request = baseReq({ flags: { replayBackend: 'maestro' } });
  const failure = await captureMaestroFailure(command, command.source.path);
  const projection = buildTypedMaestroFailureReportProjection(failure, request);

  expect(projection.command).toEqual({ kind: 'tapOn' });
  expect(projection.source).toEqual({ path: command.source.path, line: 3 });
  expect(projection.progress).toEqual({ command: 'tapOn', value: 'save' });
  expect(projection.action).toEqual({
    command: 'click',
    positionals: ['save'],
    flags: request.flags,
  });
  expect(Object.keys(projection.action)).toEqual(['command', 'positionals', 'flags']);
});

async function captureMaestroFailure(
  command: MaestroRuntimeCommand,
  sourcePath: string,
): Promise<MaestroFailedAction> {
  const flow = inspectMaestroFlow(maestroFlowForCommand(command), sourcePath);
  const error = new Error('typed Maestro action failed');
  const port: MaestroRuntimePort = {
    execute: async () => {
      throw error;
    },
    observe: async () => {
      throw error;
    },
  };
  const outcome = await executeMaestroFlow(flow, port, {
    platform: 'ios',
    readSource: noMaestroIncludeSources,
  });
  if (outcome.ok || !outcome.failure) throw new Error('expected typed Maestro failure');
  return outcome.failure;
}

function maestroFlowForCommand(command: MaestroRuntimeCommand): string {
  const authored =
    command.kind === 'inputText'
      ? { inputText: command.text }
      : command.kind === 'tapOn' && command.target.space === 'target'
        ? {
            tapOn: {
              ...command.target.selector,
            },
          }
        : undefined;
  if (!authored) throw new Error(`unsupported failure fixture: ${command.kind}`);
  return `${stringify({ appId: 'com.example.app' })}---\n${stringify([authored])}`;
}

test('typed Maestro failure diagnostics render expanded selector values without extra flags', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-expanded-selector-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const flowPath = path.join(root, 'flow.yaml');
  const label = 'Continue checkout';
  fs.writeFileSync(
    flowPath,
    ['appId: com.example.app', '---', '- tapOn: ${TARGET}', ''].join('\n'),
  );

  const response = await runReplayForTest({
    req: baseReq({
      positionals: [flowPath],
      flags: {
        replayBackend: 'maestro',
        replayEnv: [`TARGET=${label}`],
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'snapshot') {
        return {
          ok: true,
          data: {
            nodes: [
              {
                index: 0,
                depth: 0,
                type: 'Button',
                label,
                rect: { x: 20, y: 40, width: 120, height: 44 },
                hittable: true,
              },
            ],
          },
        };
      }
      if (req.command === 'click') {
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: `tap failed for ${label}`,
            hint: `Find ${label}`,
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.message).toContain(`tapOn "${label}"`);
  expect(response.error.message).toContain(label);
  expect(response.error.message).not.toContain('<var:TARGET>');
  expect(response.error.hint).toContain(label);
});

test('typed Maestro nested scopes retain resolved target values after unwind', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-nested-redaction-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const flowPath = path.join(root, 'flow.yaml');
  const tracePath = path.join(root, 'replay-timing.ndjson');
  const targetLabel = 'Nested checkout target';
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
      '            TARGET: ${SOURCE_LABEL}',
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
      label: targetLabel,
      rect: { x: 20, y: 40, width: 120, height: 44 },
      hittable: true,
    },
  ];

  const response = await runReplayForTest({
    req: baseReq({
      positionals: [flowPath],
      flags: {
        replayBackend: 'maestro',
        platform: 'ios',
        replayEnv: [`SOURCE_LABEL=${targetLabel}`],
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
            message: `tap failed for ${targetLabel}`,
            hint: `Find ${targetLabel}`,
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  expect(JSON.stringify(response)).toContain(targetLabel);
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

test('typed Maestro renders flow-local values when static include resolution fails', async () => {
  const root = mkdtempForTestSync('agent-device-maestro-include-redaction-');
  const sessionName = 'default';
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const flowPath = path.join(root, 'flow.yaml');
  const flowName = 'checkout-details';
  fs.writeFileSync(
    flowPath,
    ['env:', `  FLOW_NAME: ${flowName}`, '---', '- runFlow: ${FLOW_NAME}.yaml', ''].join('\n'),
  );

  const response = await runReplayForTest({
    req: baseReq({
      positionals: [flowPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  expect(JSON.stringify(response)).toContain(flowName);
  if (response.ok) return;
  expect(response.error.message).toContain(`${flowName}.yaml`);
});

test('typed Maestro failure diagnostics never render inputText payloads', async () => {
  const text = 'highly-sensitive-input';
  const response = await buildFailureResponse(
    { kind: 'inputText', source: { path: '/flows/login.yaml', line: 4 }, text },
    [],
  );

  expect(JSON.stringify(response.error)).not.toContain(text);
  expect(response.error.message).toContain('inputText');
});

test('typed Maestro failure publishes exactly the refs exposed by its divergence', async () => {
  const command = {
    kind: 'tapOn' as const,
    source: { path: '/flows/actions.yaml', line: 4 },
    target: { space: 'target' as const, selector: { text: 'Missing' } },
  } satisfies Extract<MaestroRuntimeCommand, { kind: 'tapOn' }>;
  const scenario = await buildFailureScenario(command, [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      label: 'Available action',
      type: 'Button',
      rect: { x: 16, y: 40, width: 140, height: 44 },
      hittable: true,
    },
  ]);
  const divergence = scenario.response.error.details?.divergence as {
    screen: { state: string; refs: Array<{ ref: string }> };
  };
  const exposedRefs = divergence.screen.refs.map(({ ref }) => ref);

  expect(divergence.screen.state).toBe('available');
  expect(exposedRefs).toEqual(['e2']);
  expect(scenario.sessionStore.get(scenario.sessionName)?.refFrameScope).toEqual(
    new Set(exposedRefs),
  );
});

test('typed Maestro suggestions rank visible childOf candidates and exclude out-of-scope nodes', async () => {
  const command = {
    kind: 'tapOn' as const,
    source: { path: '/flows/actions.yaml', line: 4 },
    target: { space: 'target' as const, selector: { text: 'save.*', childOf: { id: 'actions' } } },
  } satisfies Extract<MaestroRuntimeCommand, { kind: 'tapOn' }>;
  const response = await buildFailureResponse(command, [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      identifier: 'actions',
      type: 'View',
      rect: { x: 0, y: 0, width: 402, height: 300 },
    },
    {
      ref: 'e3',
      index: 2,
      parentIndex: 1,
      identifier: 'save-primary',
      label: 'Primary',
      type: 'Button',
      rect: { x: 16, y: 40, width: 140, height: 44 },
      hittable: true,
    },
    {
      ref: 'e4',
      index: 3,
      parentIndex: 1,
      identifier: 'secondary',
      label: 'Save secondary',
      type: 'Button',
      rect: { x: 16, y: 96, width: 140, height: 44 },
      hittable: true,
    },
    {
      ref: 'e5',
      index: 4,
      parentIndex: 0,
      identifier: 'save-outside',
      label: 'Save outside',
      type: 'Button',
      rect: { x: 16, y: 152, width: 140, height: 44 },
      hittable: true,
    },
    {
      ref: 'e6',
      index: 5,
      parentIndex: 1,
      identifier: 'save-hidden',
      label: 'Save hidden',
      type: 'Button',
      rect: { x: 16, y: 208, width: 140, height: 0 },
      hittable: false,
    },
  ]);
  const divergence = response.error.details?.divergence as {
    suggestionCount: number;
    suggestions: Array<{ selector: string; basis: string }>;
  };

  expect(divergence.suggestions).toHaveLength(2);
  expect(divergence.suggestions.map(({ basis }) => basis)).toEqual(['id', 'label']);
  expect(divergence.suggestions[0]?.selector).toContain('save-primary');
  expect(divergence.suggestions[1]?.selector).toContain('Save secondary');
  expect(divergence.suggestionCount).toBe(2);
});

test('typed Maestro text matching an identifier reports id basis', async () => {
  const command = {
    kind: 'tapOn' as const,
    source: { path: '/flows/actions.yaml', line: 4 },
    target: { space: 'target' as const, selector: { text: 'accessibility-save' } },
  } satisfies Extract<MaestroRuntimeCommand, { kind: 'tapOn' }>;
  const response = await buildFailureResponse(command, [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      ref: 'e2',
      index: 1,
      parentIndex: 0,
      identifier: 'accessibility-save',
      type: 'Button',
      rect: { x: 16, y: 40, width: 140, height: 44 },
      hittable: true,
    },
  ]);
  const divergence = response.error.details?.divergence as {
    suggestions: Array<{ basis: string }>;
  };

  expect(divergence.suggestions).toEqual([expect.objectContaining({ basis: 'id' })]);
});

test('typed Maestro suggestions retain total count before the five-entry cap', async () => {
  const command = {
    kind: 'tapOn' as const,
    source: { path: '/flows/actions.yaml', line: 4 },
    target: { space: 'target' as const, selector: { text: 'Save' } },
  } satisfies Extract<MaestroRuntimeCommand, { kind: 'tapOn' }>;
  const response = await buildFailureResponse(command, [
    {
      ref: 'e1',
      index: 0,
      type: 'Application',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    ...Array.from({ length: 6 }, (_, offset) => ({
      ref: `e${offset + 2}`,
      index: offset + 1,
      parentIndex: 0,
      label: 'Save',
      type: 'Button',
      rect: { x: 16, y: 40 + offset * 50, width: 140, height: 44 },
      hittable: true,
    })),
  ]);
  const divergence = response.error.details?.divergence as {
    suggestionCount: number;
    suggestions: unknown[];
  };

  expect(divergence.suggestionCount).toBe(6);
  expect(divergence.suggestions).toHaveLength(5);
});
