import { expect, test, vi } from 'vitest';
import type {
  ReplayBackendHost,
  ReplaySessionObservation,
  ReplaySessionStore,
} from '@agent-device/contracts/replay-backend';
import {
  collectMaestroFailureSuggestions,
  executeMaestroFlow,
  inspectMaestroFlow,
  type MaestroFailedAction,
} from '@agent-device/maestro';
import {
  buildTypedMaestroFailureReportProjection,
  buildTypedMaestroFailureResponse,
} from '../session-replay-maestro-failure.ts';

const request = { token: 'test-token', session: 'default', command: 'replay', positionals: [] };
const TAP_FLOW = ['appId: com.example.app', '---', '- tapOn:', '    id: save', ''].join('\n');

async function captureMaestroFailure(sourcePath: string): Promise<MaestroFailedAction> {
  const error = new Error('typed Maestro action failed');
  const outcome = await executeMaestroFlow(
    inspectMaestroFlow(TAP_FLOW, sourcePath),
    {
      execute: async () => {
        throw error;
      },
      observe: async () => {
        throw error;
      },
    },
    {
      platform: 'ios',
      readSource: () => {
        throw new Error('no includes');
      },
    },
  );
  if (outcome.ok || !outcome.failure) throw new Error('expected typed Maestro failure');
  return outcome.failure;
}

test('typed Maestro failure projection keeps action and source provenance', async () => {
  const failure = await captureMaestroFailure('/flows/login.yaml');
  const flags = { replayBackend: 'maestro' as const };
  const projection = buildTypedMaestroFailureReportProjection(failure, { ...request, flags });

  expect(projection.command).toEqual({ kind: 'tapOn' });
  expect(projection.source).toEqual({ path: '/flows/login.yaml', line: 3 });
  expect(projection.progress).toEqual({ command: 'tapOn', value: 'save' });
  expect(projection.action).toEqual({ command: 'click', positionals: ['save'], flags });
  expect(Object.keys(projection.action)).toEqual(['command', 'positionals', 'flags']);
});

test('the failure response hands the host the step, its warnings, and its suggestion source', async () => {
  const failure = {
    ...(await captureMaestroFailure('/flows/login.yaml')),
    warnings: ['Optional Maestro assertVisible skipped at line 2: no match'],
  };
  const buildActionFailureResponse = vi.fn<ReplayBackendHost['buildActionFailureResponse']>(
    async () => ({ ok: false, error: { code: 'REPLAY_DIVERGENCE', message: 'failed' } }),
  );
  const sessionStore: ReplaySessionStore = {
    get: () => undefined,
    lookup: () => undefined,
    getRuntimeHints: () => undefined,
    ensureSessionDir: () => '/tmp/session',
    assertSelectorMatches: () => {},
    resolveOpenRuntimeHints: () => undefined,
  };
  const observationStore: ReplaySessionObservation = {
    get: () => undefined,
    bindAuthority: () => {
      throw new Error('the host owns observation');
    },
  };

  await buildTypedMaestroFailureResponse(
    {
      appendTraceEvent: () => {},
      buildBuiltinVars: () => ({}),
      readScriptSourceFile: () => '',
      scriptSourceRequiredMessage: '',
      resolveTargetDevice: () => Promise.reject(new Error('unused')),
      requestSignal: () => undefined,
      buildActionFailureResponse,
    },
    {
      error: { code: 'COMMAND_FAILED', message: 'typed Maestro action failed' },
      failure,
      replayPath: '/flows/login.yaml',
      req: request,
      sessionStore,
      observationStore,
      logPath: '/tmp/daemon.log',
    },
  );

  const [handed] = buildActionFailureResponse.mock.calls[0] ?? [];
  const node = { index: 0, type: 'Button', label: 'save', identifier: 'save', hittable: true };
  expect(handed?.suggestNodes({ createdAt: 0, nodes: [node] })).toEqual(
    collectMaestroFailureSuggestions(failure, { createdAt: 0, nodes: [node] }),
  );
  expect(handed?.suggestNodes({ createdAt: 0, nodes: [node] })).not.toEqual([]);
  expect(buildActionFailureResponse).toHaveBeenCalledWith(
    expect.objectContaining({
      source: failure.source,
      stepIndex: failure.stepIndex,
      action: 'tapOn',
      actionLabel: 'tapOn "save"',
      isControl: false,
      warnings: ['Optional Maestro assertVisible skipped at line 2: no match'],
      captureAction: expect.objectContaining({ command: 'click', positionals: ['save'] }),
    }),
  );
});
