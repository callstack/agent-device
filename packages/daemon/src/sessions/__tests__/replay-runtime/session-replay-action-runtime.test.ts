import type { SessionAction } from '@agent-device/contracts/session';
import { expect, test } from 'vitest';
import { makeIosSession } from '../../../__tests__/support/session-factories.ts';
import { recordActionEntry } from '../../../core/session-action-recorder.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import { invokeReplayAction } from '@agent-device/replay-port/session-replay-action-runtime';
import { replayDaemonDependencies } from '../../handlers/session-replay-command.ts';
import { resolveReplayAction } from '@agent-device/ad-script';
import { createLiveTestHostEnvironment } from '@agent-device/test-kit';

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
        recordActionEntry(
          session,
          {
            command: request.command,
            positionals: request.positionals ?? [],
            flags: request.flags ?? {},
            result: { text: request.positionals?.at(-1) },
          },
          createLiveTestHostEnvironment().cwd,
        );
        return { ok: true, data: {} };
      },
    });

    expect(response.ok).toBe(true);
    expect(session.actions[0]?.positionals).toEqual(['id="password"', '${PASSWORD}']);
    expect(session.actions[0]?.result?.text).toBe('${PASSWORD}');
  },
);

test.each(['click', 'press', 'longpress'])(
  'replay dispatches a %s step with only authored and inherited flags',
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
    expect(dispatchedFlags).toEqual({});
  },
);

// #2997: the replay/test command's own --test-ime opt-in rides the parent flags onto the
// open this step dispatches; an authored step flag wins because mergeParentFlags only
// fills gaps. Without the inheritance the real-device flow open silently defaults off.
test('replay inherits the flow command testIme onto a dispatched open step', async () => {
  const action: SessionAction = {
    ts: 0,
    command: 'open',
    positionals: ['com.example.demo'],
    flags: {},
  };
  let dispatchedFlags: Record<string, unknown> | undefined;
  await invokeReplayAction({
    req: { ...REPLAY_REQUEST, flags: { testIme: true } },
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

  expect(dispatchedFlags?.testIme).toBe(true);
});

test('replay keeps an authored open step testIme over the flow command opt-out', async () => {
  const action: SessionAction = {
    ts: 0,
    command: 'open',
    positionals: ['com.example.demo'],
    flags: { testIme: true },
  };
  let dispatchedFlags: Record<string, unknown> | undefined;
  await invokeReplayAction({
    req: { ...REPLAY_REQUEST, flags: { testIme: false } },
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

  expect(dispatchedFlags?.testIme).toBe(true);
});

// #3197: a script line now parses `scroll down --until <selector>` into a flag, and the
// dispatch reads the stop condition off the request flags. If the replay dispatch dropped
// action flags for this command, the hunt would degrade to one fixed gesture again.
test('a scroll step carries its parsed --until flag onto the dispatch', async () => {
  const action: SessionAction = {
    ts: 0,
    command: 'scroll',
    positionals: ['down'],
    flags: { until: 'label="Checkout"' },
  };
  let dispatched: { positionals?: string[]; flags?: Record<string, unknown> } | undefined;
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
      dispatched = request;
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(dispatched?.positionals).toEqual(['down']);
  expect(dispatched?.flags?.until).toBe('label="Checkout"');
});

test('a gesture line whose kind came from a variable still refuses a flag the kind does not read', async () => {
  const action: SessionAction = {
    ts: 0,
    command: 'gesture',
    positionals: ['${KIND}', '1.5'],
    flags: { count: 3 },
  };
  let dispatched = false;
  const response = await invokeReplayAction({
    req: REPLAY_REQUEST,
    sessionName: 'default',
    action,
    resolved: { ...action, positionals: ['pinch', '1.5'] },
    filePath: 'flow.ad',
    line: 1,
    step: 1,
    resolvedSessionScope: undefined,
    dependencies: replayDaemonDependencies,
    invoke: async () => {
      dispatched = true;
      return { ok: true, data: {} };
    },
  });

  expect(dispatched).toBe(false);
  expect(response.ok).toBe(false);
  expect(response.ok ? undefined : response.error.message).toContain(
    'gesture pinch does not read --count (after variable substitution).',
  );
});
