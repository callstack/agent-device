import type { SessionAction } from '@agent-device/contracts/session';
import { expect, test } from 'vitest';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { recordActionEntry } from '../../session-action-recorder.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import { invokeReplayAction } from '@agent-device/replay-port/session-replay-action-runtime';
import { replayDaemonDependencies } from '../../handlers/session-replay-command.ts';
import { resolveReplayAction } from '@agent-device/ad-script';

const REPLAY_REQUEST: DaemonRequest = {
  token: 'token',
  session: 'default',
  command: 'replay',
  positionals: ['login.ad'],
  flags: {},
};

test.each(['', '   '])(
  'replay keeps source placeholder provenance when PASSWORD resolves to %j',
  async (value) => {
    const session = makeIosSession('default');
    const sourceAction: SessionAction = {
      ts: 0,
      command: 'fill',
      positionals: ['id="password"', '${PASSWORD}'],
      flags: {},
    };
    // `invokeReplayAction` no longer resolves `${VAR}`s itself (#1555 review
    // P1, "move variable semantics/planning behind the replay entrypoint") —
    // it receives an already-resolved action, exactly as `runAdReplay` (the
    // engine) now produces one per step.
    const scope = { values: { PASSWORD: value } };
    const resolved = resolveReplayAction(sourceAction, scope, { file: 'login.ad', line: 1 });
    const response = await invokeReplayAction({
      req: REPLAY_REQUEST,
      sessionName: 'default',
      action: sourceAction,
      resolved,
      filePath: 'login.ad',
      line: 1,
      step: 1,
      resolvedSessionScope: undefined,
      dependencies: replayDaemonDependencies,
      invoke: async (request) => {
        recordActionEntry(session, {
          command: request.command,
          positionals: request.positionals ?? [],
          flags: request.flags ?? {},
          result: { text: request.positionals?.at(-1) },
        });
        return { ok: true, data: {} };
      },
    });

    expect(response.ok).toBe(true);
    expect(session.actions[0]?.positionals).toEqual(['id="password"', '${PASSWORD}']);
    expect(session.actions[0]?.result?.text).toBe('${PASSWORD}');
  },
);

// A replay step has no CLI flag to carry a readiness budget, so `buildReplayActionFlags` defaults
// one in for press/click/longpress.
test.each(['press', 'click', 'longpress'])(
  'replay defaults readinessTimeoutMs onto a dispatched %s step',
  async (command) => {
    const action: SessionAction = { ts: 0, command, positionals: ['label="Continue"'], flags: {} };
    let dispatchedFlags: Record<string, unknown> | undefined;
    const response = await invokeReplayAction({
      req: REPLAY_REQUEST,
      sessionName: 'default',
      action,
      resolved: action,
      filePath: 'flow.ad',
      line: 1,
      step: 1,
      resolvedSessionScope: undefined,
      dependencies: replayDaemonDependencies,
      invoke: async (request) => {
        dispatchedFlags = request.flags;
        return { ok: true, data: {} };
      },
    });

    expect(response.ok).toBe(true);
    expect(dispatchedFlags?.readinessTimeoutMs).toBe(2_000);
  },
);

test('replay keeps a readinessTimeoutMs the step already carries instead of overwriting it', async () => {
  const action: SessionAction = {
    ts: 0,
    command: 'press',
    positionals: ['label="Continue"'],
    flags: { readinessTimeoutMs: 500 },
  };
  let dispatchedFlags: Record<string, unknown> | undefined;
  const response = await invokeReplayAction({
    req: REPLAY_REQUEST,
    sessionName: 'default',
    action,
    resolved: action,
    filePath: 'flow.ad',
    line: 1,
    step: 1,
    resolvedSessionScope: undefined,
    dependencies: replayDaemonDependencies,
    invoke: async (request) => {
      dispatchedFlags = request.flags;
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(dispatchedFlags?.readinessTimeoutMs).toBe(500);
});

test('replay never defaults readinessTimeoutMs onto a non-acting step', async () => {
  const action: SessionAction = {
    ts: 0,
    command: 'wait',
    positionals: ['label="Continue"'],
    flags: {},
  };
  let dispatchedFlags: Record<string, unknown> | undefined;
  const response = await invokeReplayAction({
    req: REPLAY_REQUEST,
    sessionName: 'default',
    action,
    resolved: action,
    filePath: 'flow.ad',
    line: 1,
    step: 1,
    resolvedSessionScope: undefined,
    dependencies: replayDaemonDependencies,
    invoke: async (request) => {
      dispatchedFlags = request.flags;
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(dispatchedFlags?.readinessTimeoutMs).toBeUndefined();
});
