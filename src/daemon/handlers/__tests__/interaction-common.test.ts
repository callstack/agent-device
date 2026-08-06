import type { CommandFlags } from '@agent-device/contracts/command';
import { beforeEach, expect, test, vi } from 'vitest';
import {
  makeIosSession,
  makeAuthoringSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { handleInteractionCommands } from '../interaction.ts';
import { finalizeTouchInteraction } from '../interaction-common.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
const mockDispatch = vi.mocked(dispatchCommand);
const contextFromFlags = (_flags: CommandFlags | undefined) => ({});

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
});

test('parameterized fill scrubs backend and nested settle echoes at the response boundary', () => {
  const secret = 'OpaqueValue1348';
  const placeholder = '${PASSWORD}';
  const sessionStore = makeSessionStore();
  const session = makeAuthoringSession('parameterized-fill');
  sessionStore.set(session.name, session);
  const payload = {
    text: secret,
    message: `prefix${secret}suffix`,
    refLabel: `prefix${secret}suffix`,
    selector: 'id="password"',
    selectorChain: [
      'id="password"',
      `value="prefix${secret}suffix" editable=true`,
      `label="${secret}4"`,
    ],
    backendEcho: {
      id: secret,
      status: `accepted${secret}suffix`,
      nested: { kind: secret },
      [secret]: true,
      [`prefix${secret}suffix`]: {
        [`${secret}4`]: true,
      },
    },
    settle: {
      settled: true,
      waitedMs: 1,
      captures: 2,
      quietMs: 1,
      timeoutMs: 100,
      diff: {
        summary: { additions: 1, removals: 0, unchanged: 0 },
        lines: [{ kind: 'added', text: `TextField value=prefix${secret}suffix` }],
      },
      hint: `Observed ${secret}4`,
      [`echo${secret}key`]: true,
      backendEcho: {
        id: secret,
        [`key${secret}`]: `value${secret}`,
      },
    },
  };

  const response = finalizeTouchInteraction({
    session,
    sessionStore,
    command: 'fill',
    positionals: ['id="password"', secret],
    flags: { recordAs: 'PASSWORD' },
    result: payload,
    responseData: payload,
    actionStartedAt: 1,
    actionFinishedAt: 2,
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(response.data).toMatchObject({
    text: placeholder,
    message: `prefix${placeholder}suffix`,
    refLabel: `prefix${placeholder}suffix`,
    selector: 'id="password"',
    selectorChain: ['id="password"'],
    backendEcho: {
      id: placeholder,
      status: `accepted${placeholder}suffix`,
      nested: { kind: placeholder },
      [placeholder]: true,
      [`prefix${placeholder}suffix`]: {
        [`${placeholder}4`]: true,
      },
    },
    settle: {
      diff: {
        lines: [{ kind: 'added', text: `TextField value=prefix${placeholder}suffix` }],
      },
      hint: `Observed ${placeholder}4`,
      [`echo${placeholder}key`]: true,
      backendEcho: {
        id: placeholder,
        [`key${placeholder}`]: `value${placeholder}`,
      },
    },
  });
  expect(JSON.stringify(response.data)).not.toContain(secret);

  const recordedResult = session.actions[0]?.result;
  expect(recordedResult).toEqual(response.data);
  expect(JSON.stringify(recordedResult)).not.toContain(secret);
});

test('parameterized fill scrubs concatenated backend values and object keys through the handler route', async () => {
  const secret = 'TOKEN123';
  const placeholder = '${PASSWORD}';
  const sessionStore = makeSessionStore();
  const sessionName = 'parameterized-fill-handler-route';
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  const nodes: RawSnapshotNode[] = [
    {
      index: 0,
      type: 'XCUIElementTypeTextField',
      identifier: 'password',
      label: 'Password',
      rect: { x: 20, y: 40, width: 200, height: 44 },
      enabled: true,
      hittable: true,
    },
  ];
  session.recordSession = true;
  session.snapshot = {
    nodes: attachRefs(nodes),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockImplementation(async (_device, command) =>
    command === 'fill'
      ? {
          message: `prefix${secret}suffix`,
          [`prefix${secret}suffix`]: {
            [`${secret}4`]: `echo${secret}`,
          },
        }
      : {},
  );

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', secret],
      flags: { recordAs: 'PASSWORD' },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
  if (!response?.ok) return;
  expect(response.data).toMatchObject({
    message: 'Filled 8 chars',
    [`prefix${placeholder}suffix`]: {
      [`${placeholder}4`]: `echo${placeholder}`,
    },
    ref: 'e1',
    text: placeholder,
  });
  expect(JSON.stringify(response.data)).not.toContain(secret);
  expect(JSON.stringify(session.actions)).not.toContain(secret);
  expect(mockDispatch.mock.calls[0]?.[1]).toBe('fill');
  expect(mockDispatch.mock.calls[0]?.[2]).toContain(secret);
});

test('parameterized fill collapses whitespace-only backend echoes through the handler route', async () => {
  const secret = '   ';
  const placeholder = '${SPACES}';
  const sessionStore = makeSessionStore();
  const sessionName = 'parameterized-whitespace-fill-handler-route';
  const session = makeAuthoringSession(sessionName, { appBundleId: 'com.example.app' });
  session.snapshot = {
    nodes: attachRefs([
      {
        index: 0,
        type: 'XCUIElementTypeTextField',
        identifier: 'password',
        label: 'Password',
        rect: { x: 20, y: 40, width: 200, height: 44 },
        enabled: true,
        hittable: true,
      },
    ]),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue({
    [`prefix${secret}suffix`]: {
      [`key${secret}tail`]: `value${secret}tail`,
    },
    selectorChain: [`value="prefix${secret}suffix"`],
  });

  const response = await handleInteractionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'fill',
      positionals: ['@e1', secret],
      flags: { recordAs: 'SPACES' },
    },
    sessionName,
    sessionStore,
    contextFromFlags,
  });

  expect(response, JSON.stringify(response)).toMatchObject({ ok: true });
  if (!response?.ok) return;
  expect(response.data).toBeDefined();
  const responseData = response.data!;
  expect(responseData).toMatchObject({
    [placeholder]: {
      [placeholder]: placeholder,
    },
    text: placeholder,
  });
  expect(responseData.selectorChain).not.toContain(`value="prefix${secret}suffix"`);
  expect(JSON.stringify(responseData)).not.toContain(secret);
  expect(session.actions[0]?.result).toMatchObject({
    [placeholder]: {
      [placeholder]: placeholder,
    },
    text: placeholder,
  });
  expect(session.actions[0]?.result?.selectorChain).not.toContain(`value="prefix${secret}suffix"`);
  expect(JSON.stringify(session.actions)).not.toContain(secret);
  expect(mockDispatch.mock.calls[0]?.[2]).toContain(secret);
});

test.each([
  { literal: 'PASSWORD', recordAs: 'PASSWORD' },
  { literal: '$', recordAs: 'DOLLAR' },
])(
  'parameterization remains stable across response and recorder boundaries for $literal',
  ({ literal, recordAs }) => {
    const placeholder = `\${${recordAs}}`;
    const sessionStore = makeSessionStore();
    const session = makeAuthoringSession(`parameterized-overlap-${recordAs}`);
    sessionStore.set(session.name, session);
    const payload = {
      text: literal,
      refLabel: `prefix${literal}suffix`,
      backendEcho: {
        [`key${literal}`]: `value${literal}`,
      },
      settle: { hint: `hint${literal}` },
    };

    const response = finalizeTouchInteraction({
      session,
      sessionStore,
      command: 'fill',
      positionals: ['id="password"', literal],
      flags: { recordAs },
      result: payload,
      responseData: payload,
      actionStartedAt: 1,
      actionFinishedAt: 2,
    });

    expect(response).toEqual({
      ok: true,
      data: {
        text: placeholder,
        refLabel: `prefix${placeholder}suffix`,
        backendEcho: {
          [`key${placeholder}`]: `value${placeholder}`,
        },
        settle: { hint: `hint${placeholder}` },
      },
    });
    if (!response.ok) return;
    expect(session.actions[0]?.result).toEqual(response.data);
  },
);
