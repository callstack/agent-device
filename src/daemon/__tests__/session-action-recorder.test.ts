/**
 * #1271 stage 2 (ADR 0012 amendment): `recordActionEntry`'s repair-segment
 * default exclusion — the single daemon-side choke point every recording
 * surface (CLI/Node client/MCP) funnels through via `SessionStore.recordAction`.
 * Isolates the mechanism itself from the classification wiring
 * (`selector-recording.test.ts` covers which commands set `interactiveObservation`).
 */
import { test, expect } from 'vitest';
import { recordActionEntry } from '../session-action-recorder.ts';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';

test('an observation-only action is excluded while repair-armed and no --record is given', () => {
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  const action = recordActionEntry(session, {
    command: 'get',
    positionals: ['attrs', 'id="save"'],
    flags: {},
    result: {},
    interactiveObservation: true,
  });
  expect(action).toBeUndefined();
  expect(session.actions).toHaveLength(0);
});

test('--record forces an observation-only action through while repair-armed', () => {
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  const action = recordActionEntry(session, {
    command: 'get',
    positionals: ['attrs', 'id="save"'],
    flags: { record: true },
    result: {},
    interactiveObservation: true,
  });
  expect(action).toBeDefined();
  expect(session.actions.map((a) => a.command)).toEqual(['get']);
});

test('an observation-only action records normally outside a repair-armed session (ordinary authoring recording is unchanged)', () => {
  const session = makeIosSession('default');
  expect(session.saveScriptBoundary).toBeUndefined();
  const action = recordActionEntry(session, {
    command: 'is',
    positionals: ['visible', 'id="save"'],
    flags: {},
    result: {},
    interactiveObservation: true,
  });
  expect(action).toBeDefined();
  expect(session.actions.map((a) => a.command)).toEqual(['is']);
});

test('a mutating action is never excluded, repair-armed or not', () => {
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  const action = recordActionEntry(session, {
    command: 'press',
    positionals: ['@e5'],
    flags: {},
    result: {},
  });
  expect(action).toBeDefined();
  expect(session.actions.map((a) => a.command)).toEqual(['press']);
});

test('a command explicitly marked NOT observation-only (e.g. the top-level `wait`) always records, even while repair-armed', () => {
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  const action = recordActionEntry(session, {
    command: 'wait',
    positionals: ['500'],
    flags: {},
    result: {},
    interactiveObservation: false,
  });
  expect(action).toBeDefined();
  expect(session.actions.map((a) => a.command)).toEqual(['wait']);
});

test('--no-record still takes precedence over an observation-only action, repair-armed or not', () => {
  const session = makeIosSession('default', { saveScriptBoundary: 0 });
  const action = recordActionEntry(session, {
    command: 'get',
    positionals: ['attrs', 'id="save"'],
    flags: { noRecord: true },
    result: {},
    interactiveObservation: true,
  });
  expect(action).toBeUndefined();
  expect(session.actions).toHaveLength(0);
});

test('parameterized fills keep literals out of recording state with deterministic placeholders', () => {
  const session = makeIosSession('default');
  const password = 'literal-password-1348';
  const token = 'literal-token-1348';
  const passwordEntry = {
    command: 'fill',
    positionals: ['id="password"', password],
    flags: { recordAs: 'PASSWORD' },
    result: {
      text: password,
      message: `Filled ${password}`,
      selectorChain: ['id="password"', `value="${password}" editable=true`],
      settle: { diff: `value=${password}` },
    },
    targetEvidence: {
      role: 'textinput',
      label: `Current value ${password}`,
      ancestry: [{ role: 'form', label: `Credential ${password}` }],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified' as const,
    },
  };

  recordActionEntry(session, passwordEntry);
  recordActionEntry(session, passwordEntry);
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="token"', token],
    flags: { recordAs: 'API_TOKEN' },
    result: { text: token, message: `Filled ${token}` },
  });

  expect(session.actions.map((action) => action.positionals.at(-1))).toEqual([
    '${PASSWORD}',
    '${PASSWORD}',
    '${API_TOKEN}',
  ]);
  const serialized = JSON.stringify(session.actions);
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(token);
  expect(serialized).toContain('value=${PASSWORD}');
  expect(session.actions[0]?.targetEvidence?.label).toBe('Current value ${PASSWORD}');
  expect(session.actions[0]?.targetEvidence?.ancestry[0]?.label).toBe('Credential ${PASSWORD}');
  expect(session.actions[0]?.result?.selectorChain).toEqual(['id="password"']);
});
