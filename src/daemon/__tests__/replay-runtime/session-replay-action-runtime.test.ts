import type { SessionAction } from '@agent-device/contracts/session';
import { expect, test } from 'vitest';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { recordActionEntry } from '../../session-action-recorder.ts';
import type { DaemonRequest } from '../../daemon-request.ts';
import {
  invokeReplayAction,
  replayStepReadinessSchedule,
} from '@agent-device/replay-port/session-replay-action-runtime';
import {
  SELECTOR_PIPELINE_POLICIES,
  readinessScheduleFor,
} from '@agent-device/selectors/selector-pipeline-policy';
import { replayDaemonDependencies } from '../../handlers/session-replay-command.ts';
import { resolveReplayAction } from '@agent-device/ad-script';
import {
  commandAcceptsReadinessBudget,
  commandDescriptors,
} from '@agent-device/command-registry/registry';

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

const READINESS_BUDGETED_COMMANDS = commandDescriptors
  .map((descriptor) => descriptor.name)
  .filter((command) => commandAcceptsReadinessBudget(command));

// A replay step has no CLI flag to carry a readiness budget, so `buildReplayActionFlags` defaults
// one in for every readiness-budgeted command.
test.each(READINESS_BUDGETED_COMMANDS)(
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

// The dispatch resolves a press/click/longpress target under the promotedTarget row with the
// readinessTimeoutMs it receives; the pre-dispatch gate must poll under that same schedule.
test.each([
  ...READINESS_BUDGETED_COMMANDS.map((command) => ({ command, flags: {} })),
  { command: 'click', flags: { readinessTimeoutMs: 700 } },
  { command: 'press', flags: { readinessTimeoutMs: 9_000 } },
])('the replay gate and the dispatch poll a $command step under one schedule', async (step) => {
  const action: SessionAction = {
    ts: 0,
    command: step.command,
    positionals: ['label="Continue"'],
    flags: step.flags,
  };
  let dispatchedFlags: Record<string, unknown> | undefined;
  await invokeReplayAction({
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

  const dispatchSchedule = readinessScheduleFor(
    SELECTOR_PIPELINE_POLICIES.promotedTarget.poll,
    dispatchedFlags?.readinessTimeoutMs as number | undefined,
  );
  expect(dispatchSchedule).toBeDefined();
  expect(await replayStepReadinessSchedule(REPLAY_REQUEST.flags, action)).toEqual(dispatchSchedule);
});

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
