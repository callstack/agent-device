import { isSessionRecording } from '../session-script-publication-capability.ts';
/**
 * #1271 stage 2 (ADR 0012 amendment): `recordActionEntry`'s repair-segment
 * default exclusion — the single daemon-side choke point every recording
 * surface (CLI/Node client/MCP) funnels through via `SessionStore.recordAction`.
 * Isolates the mechanism itself from the classification wiring
 * (`selector-recording.test.ts` covers which commands set `interactiveObservation`).
 */
import { test, expect } from 'vitest';
import { recordActionEntry } from '../session-action-recorder.ts';
import {
  authoringPublication,
  makeIosSession,
} from '../../__tests__/test-utils/session-factories.ts';

test('an observation-only action is excluded while repair-armed and no --record is given', () => {
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
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
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
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
  expect(session.scriptPublication).toBeUndefined();
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
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
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
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
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
  const session = makeIosSession('default', {
    scriptPublication: {
      kind: 'repair',
      status: 'armed',
      target: { kind: 'default', force: false },
      boundary: 0,
    },
  });
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
      selector: 'id="password"',
      selectorChain: ['id="password"', `value="${password}" editable=true`],
      settle: {
        diff: {
          lines: [{ kind: 'added', text: `value=${password}` }],
        },
      },
    },
    targetEvidence: {
      role: 'textinput',
      label: password,
      ancestry: [{ role: 'form', label: 'Credentials' }],
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
    result: { text: token, message: 'Filled 18 chars' },
  });

  expect(session.actions.map((action) => action.positionals.at(-1))).toEqual([
    '${PASSWORD}',
    '${PASSWORD}',
    '${API_TOKEN}',
  ]);
  const serialized = JSON.stringify(session.actions);
  expect(serialized).not.toContain(password);
  expect(serialized).not.toContain(token);
  expect(session.actions[0]?.result?.text).toBe('${PASSWORD}');
  expect(session.actions[0]?.result?.message).toBe('Filled ${PASSWORD}');
  expect(session.actions[0]?.result?.selector).toBe('id="password"');
  expect(session.actions[0]?.targetEvidence?.label).toBe('${PASSWORD}');
  expect(session.actions[0]?.targetEvidence?.ancestry[0]?.label).toBe('Credentials');
  expect(session.actions[0]?.result?.selectorChain).toEqual(['id="password"']);
  expect(session.actions[0]?.result?.settle).toEqual({
    diff: {
      lines: [{ kind: 'added', text: 'value=${PASSWORD}' }],
    },
  });
});

test('a one-character parameterized fill preserves structural selector provenance', () => {
  const session = makeIosSession('default');
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', 'a'],
    flags: { recordAs: 'LETTER' },
    result: {
      text: 'a',
      message: 'Already safe',
      selector: 'id="password"',
      selectorChain: ['id="password"', 'label="Account"', 'value="a" editable=true'],
    },
    targetEvidence: {
      role: 'textinput',
      label: 'Password',
      ancestry: [{ role: 'form', label: 'Credentials area' }],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified',
    },
  });

  expect(session.actions[0]).toMatchObject({
    positionals: ['id="password"', '${LETTER}'],
    result: {
      text: '${LETTER}',
      message: 'Alre${LETTER}dy s${LETTER}fe',
      selector: 'id="password"',
      selectorChain: ['id="password"', 'label="Account"'],
    },
    targetEvidence: {
      label: 'Password',
      ancestry: [{ role: 'form', label: 'Credentials area' }],
    },
  });
});

test.each(['', '   '])(
  'parameterized fills preserve the placeholder when the resolved value is %j',
  (value) => {
    const session = makeIosSession('default');
    recordActionEntry(session, {
      command: 'fill',
      positionals: ['id="password"', value],
      flags: { recordAs: 'PASSWORD' },
      result: { text: value },
    });

    expect(session.actions[0]?.positionals).toEqual(['id="password"', '${PASSWORD}']);
    expect(session.actions[0]?.result?.text).toBe('${PASSWORD}');
  },
);

test('whitespace-only fills collapse ambiguous recorder output and keys', () => {
  const session = makeIosSession('default');
  const whitespace = '   ';
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', whitespace],
    flags: { recordAs: 'PASSWORD' },
    result: {
      text: whitespace,
      message: `prefix${whitespace}suffix`,
      backend: {
        [`key${whitespace}tail`]: `value${whitespace}tail`,
      },
      selectorChain: ['id="password"', `value="prefix${whitespace}suffix"`],
    },
  });

  expect(session.actions[0]?.result).toEqual({
    text: '${PASSWORD}',
    message: '${PASSWORD}',
    backend: {
      '${PASSWORD}': '${PASSWORD}',
    },
    selectorChain: ['id="password"'],
  });
  expect(JSON.stringify(session.actions)).not.toContain(whitespace);
});

test('#1533: the --save-script ingress does not re-arm an aborted authoring lifecycle', () => {
  const session = makeIosSession('s', {
    // What `abortAuthoringOnSecondOpen` leaves behind: a terminal status, which
    // is by itself what stops the session recording.
    scriptPublication: authoringPublication('aborted'),
  });

  // The second `open --save-script` records its own action, carrying the flag
  // that caused the abort into the recorder's shared ingress.
  recordActionEntry(session, {
    command: 'open',
    positionals: ['com.example.other'],
    flags: { saveScript: true },
  });

  expect(isSessionRecording(session)).toBe(false);
  expect(session.scriptPublication).toEqual(authoringPublication('aborted'));
});

test('#1533: an aborted lifecycle cannot be retargeted by a later --save-script=<path> either', () => {
  const session = makeIosSession('s', {
    scriptPublication: authoringPublication('aborted', { path: '/tmp/original.ad' }),
  });

  recordActionEntry(session, {
    command: 'open',
    positionals: ['com.example.other'],
    flags: { saveScript: '/tmp/hijacked.ad', force: true },
  });

  expect(isSessionRecording(session)).toBe(false);
  expect(session.scriptPublication).toEqual(
    authoringPublication('aborted', { path: '/tmp/original.ad' }),
  );
});

test('#1533: an ARMED authoring lifecycle still takes the ingress (retarget + force unchanged)', () => {
  const session = makeIosSession('s', {
    scriptPublication: authoringPublication('armed'),
  });

  recordActionEntry(session, {
    command: 'close',
    positionals: [],
    flags: { saveScript: '/tmp/out.ad', force: true },
  });

  expect(isSessionRecording(session)).toBe(true);
  expect(session.scriptPublication).toEqual(
    authoringPublication('armed', { path: '/tmp/out.ad', force: true }),
  );
});

// #1398: session-scoped echo protection. A LATER, unrelated action can
// independently observe an app-rendered echo of an earlier parameterized
// fill's literal (its own displayed value, a search result, a confirmation
// label, a caller-authored destination landmark). These tests prove the
// echo never reaches `session.actions` regardless of which later command
// records it, while never falsely claiming replay-verified identity.

test('#1398: a landmark-mode wait recorded after a parameterized fill drops identity evidence that echoes the literal', () => {
  const session = makeIosSession('default');
  const literal = 'hunter2-secret';

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', literal],
    flags: { recordAs: 'PASSWORD' },
    result: { text: literal },
  });
  recordActionEntry(session, {
    command: 'wait',
    positionals: ['role="heading"'],
    flags: {},
    result: { waitedMs: 12, text: `Welcome, ${literal}`, hint: `matched Welcome, ${literal}` },
    targetEvidence: {
      role: 'heading',
      label: `Welcome, ${literal}`,
      ancestry: [{ role: 'window' }],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified',
    },
    targetEvidenceMode: 'landmark',
  });

  const wait = session.actions[1];
  expect(wait?.command).toBe('wait');
  expect(wait?.targetEvidence).toBeUndefined();
  expect(wait?.result).toEqual({
    waitedMs: 12,
    text: 'Welcome, ${PASSWORD}',
    hint: 'matched Welcome, ${PASSWORD}',
  });
  expect(JSON.stringify(session.actions)).not.toContain(literal);
});

test('#1398: a landmark-mode wait drops identity evidence when the echo is only in the ancestry chain', () => {
  const session = makeIosSession('default');
  const literal = 'hunter2-secret';

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', literal],
    flags: { recordAs: 'PASSWORD' },
    result: { text: literal },
  });
  recordActionEntry(session, {
    command: 'wait',
    positionals: ['role="button" label="Continue"'],
    flags: {},
    result: { waitedMs: 5 },
    targetEvidence: {
      role: 'button',
      label: 'Continue',
      ancestry: [{ role: 'group', label: `Signed in as ${literal}` }],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified',
    },
    targetEvidenceMode: 'landmark',
  });

  expect(session.actions[1]?.targetEvidence).toBeUndefined();
});

test('#1398: action-mode evidence (get/is) redacts an echoed label and downgrades to unverifiable instead of dropping required identity evidence', () => {
  const session = makeIosSession('default');
  const literal = 'hunter2-secret';

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', literal],
    flags: { recordAs: 'PASSWORD' },
    result: { text: literal },
  });
  recordActionEntry(session, {
    command: 'is',
    positionals: ['visible', 'id="password"'],
    flags: {},
    result: {},
    targetEvidence: {
      role: 'textinput',
      label: `Password: ${literal}`,
      ancestry: [{ role: 'form', label: 'Credentials' }],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified',
    },
  });

  expect(session.actions[1]?.targetEvidence).toEqual({
    role: 'textinput',
    label: 'Password: ${PASSWORD}',
    ancestry: [{ role: 'form', label: 'Credentials' }],
    sibling: 0,
    viewportOrder: 0,
    verification: 'unverifiable',
  });
  expect(JSON.stringify(session.actions)).not.toContain(literal);
});

test('#1398: action-mode evidence redacts EVERY registered literal echoed in the same label, not just the first match', () => {
  const session = makeIosSession('default');

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="username"', 'bob'],
    flags: { recordAs: 'USERNAME' },
    result: { text: 'bob' },
  });
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', 'hunter2-secret'],
    flags: { recordAs: 'PASSWORD' },
    result: { text: 'hunter2-secret' },
  });
  recordActionEntry(session, {
    command: 'is',
    positionals: ['visible', 'id="session-banner"'],
    flags: {},
    result: {},
    targetEvidence: {
      role: 'text',
      label: 'Signed in as bob, session hunter2-secret',
      ancestry: [],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified',
    },
  });

  expect(session.actions[2]?.targetEvidence).toEqual({
    role: 'text',
    label: 'Signed in as ${USERNAME}, session ${PASSWORD}',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'unverifiable',
  });
  const serialized = JSON.stringify(session.actions);
  expect(serialized).not.toContain('bob');
  expect(serialized).not.toContain('hunter2-secret');
});

test('#1398: two distinct --record-as names sharing the same literal value deterministically keep the first-registered name', () => {
  const session = makeIosSession('default');

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', 'hunter2'],
    flags: { recordAs: 'PASSWORD' },
    result: { text: 'hunter2' },
  });
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="confirm"', 'hunter2'],
    flags: { recordAs: 'CONFIRM_PASSWORD' },
    result: { text: 'hunter2' },
  });
  recordActionEntry(session, {
    command: 'wait',
    positionals: ['id="confirmation-banner"'],
    flags: {},
    result: { waitedMs: 1, text: 'Passwords match: hunter2' },
  });

  expect(session.actions[2]?.result).toEqual({
    waitedMs: 1,
    text: 'Passwords match: ${PASSWORD}',
  });
  expect(JSON.stringify(session.actions)).not.toContain('hunter2');
});

// #1398 review fix: a naive sequential per-pair pass can corrupt an EARLIER
// pair's just-inserted placeholder when a LATER pair's literal happens to be
// a substring of it. Register `somethinglong -> ${ABC}` then `ABC ->
// ${OTHER}` (a --record-as name that collides with an unrelated variable's
// own literal value): a later echo of "somethinglong" must become exactly
// `${ABC}`, never the corrupted `${${OTHER}}` a naive second full-string pass
// over the already-rewritten text would produce.
test('#1398: redacting one literal never corrupts a placeholder another literal already produced (result payload)', () => {
  const session = makeIosSession('default');

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="field-one"', 'somethinglong'],
    flags: { recordAs: 'ABC' },
    result: { text: 'somethinglong' },
  });
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="field-two"', 'ABC'],
    flags: { recordAs: 'OTHER' },
    result: { text: 'ABC' },
  });
  recordActionEntry(session, {
    command: 'wait',
    positionals: ['id="confirmation-banner"'],
    flags: {},
    result: { waitedMs: 1, text: 'Echo: somethinglong' },
  });

  expect(session.actions[2]?.result).toEqual({ waitedMs: 1, text: 'Echo: ${ABC}' });
  const serialized = JSON.stringify(session.actions);
  expect(serialized).not.toContain('somethinglong');
  expect(serialized).not.toContain('${${OTHER}}');
});

test('#1398: redacting one literal never corrupts a placeholder another literal already produced (action-mode target evidence)', () => {
  const session = makeIosSession('default');

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="field-one"', 'somethinglong'],
    flags: { recordAs: 'ABC' },
    result: { text: 'somethinglong' },
  });
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="field-two"', 'ABC'],
    flags: { recordAs: 'OTHER' },
    result: { text: 'ABC' },
  });
  recordActionEntry(session, {
    command: 'is',
    positionals: ['visible', 'id="confirmation-banner"'],
    flags: {},
    result: {},
    targetEvidence: {
      role: 'text',
      label: 'Echo: somethinglong',
      ancestry: [],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified',
    },
  });

  expect(session.actions[2]?.targetEvidence).toEqual({
    role: 'text',
    label: 'Echo: ${ABC}',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'unverifiable',
  });
  const serialized = JSON.stringify(session.actions);
  expect(serialized).not.toContain('somethinglong');
  expect(serialized).not.toContain('${${OTHER}}');
});

// #1398 review fix: a registered literal is matched BEFORE checking whether
// an existing placeholder token starts at the current position, so a typed
// value that itself happens to look like `${SOMETHING}` is still redacted
// rather than being skipped as if it were already-parameterized text.
test('#1398: a literal whose own text is shaped like an existing placeholder is still redacted', () => {
  const session = makeIosSession('default');
  const literal = '${OTHERVAR}';

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="field"', literal],
    flags: { recordAs: 'TOKEN' },
    result: { text: literal },
  });
  recordActionEntry(session, {
    command: 'wait',
    positionals: ['id="confirmation-banner"'],
    flags: {},
    result: { waitedMs: 1, text: `Echo: ${literal}` },
  });

  expect(session.actions[1]?.result).toEqual({ waitedMs: 1, text: 'Echo: ${TOKEN}' });
  expect(JSON.stringify(session.actions)).not.toContain('OTHERVAR');
});

test('#1398: dual-endpoint (targetEvidences) evidence is protected independently per endpoint', () => {
  const session = makeIosSession('default');
  const literal = 'hunter2-secret';

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', literal],
    flags: { recordAs: 'PASSWORD' },
    result: { text: literal },
  });
  recordActionEntry(session, {
    command: 'drag',
    positionals: ['id="source"', 'id="dest"'],
    flags: {},
    result: {},
    targetEvidences: {
      source: {
        role: 'button',
        label: 'Drag me',
        ancestry: [],
        sibling: 0,
        viewportOrder: 0,
        verification: 'verified',
      },
      destination: {
        role: 'dropzone',
        label: literal,
        ancestry: [],
        sibling: 0,
        viewportOrder: 0,
        verification: 'verified',
      },
    },
  });

  const drag = session.actions[1];
  expect(drag?.targetEvidences?.source).toEqual({
    role: 'button',
    label: 'Drag me',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  });
  expect(drag?.targetEvidences?.destination).toEqual({
    role: 'dropzone',
    label: '${PASSWORD}',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'unverifiable',
  });
});

test('#1398: multiple registered literals apply longest-first so a shorter value never partially consumes a longer one', () => {
  const session = makeIosSession('default');

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', 'bob123'],
    flags: { recordAs: 'PASSWORD' },
    result: { text: 'bob123' },
  });
  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="username"', 'bob'],
    flags: { recordAs: 'USERNAME' },
    result: { text: 'bob' },
  });
  recordActionEntry(session, {
    command: 'wait',
    positionals: ['text="Welcome bob123!"'],
    flags: {},
    result: { waitedMs: 1, text: 'Welcome bob123!' },
  });

  expect(session.actions[2]?.result).toEqual({ waitedMs: 1, text: 'Welcome ${PASSWORD}!' });
});

test('#1398: a whitespace-only --record-as value keeps only fill-step-scoped protection (not registered session-wide)', () => {
  const session = makeIosSession('default');
  const whitespace = '   ';

  recordActionEntry(session, {
    command: 'fill',
    positionals: ['id="password"', whitespace],
    flags: { recordAs: 'PASSWORD' },
    result: { text: whitespace },
  });
  expect(session.recordedFillLiterals).toBeUndefined();

  recordActionEntry(session, {
    command: 'wait',
    positionals: ['text="a b c"'],
    flags: {},
    result: { waitedMs: 1, text: 'a b c' },
  });

  expect(session.actions[1]?.result).toEqual({ waitedMs: 1, text: 'a b c' });
});

test('#1398: ordinary recordings with no --record-as fill are completely unaffected', () => {
  const session = makeIosSession('default');
  recordActionEntry(session, {
    command: 'wait',
    positionals: ['role="heading" label="Home"'],
    flags: {},
    result: { waitedMs: 2, text: 'Home' },
    targetEvidence: {
      role: 'heading',
      label: 'Home',
      ancestry: [],
      sibling: 0,
      viewportOrder: 0,
      verification: 'verified',
    },
    targetEvidenceMode: 'landmark',
  });

  expect(session.recordedFillLiterals).toBeUndefined();
  expect(session.actions[0]?.targetEvidence).toEqual({
    role: 'heading',
    label: 'Home',
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  });
});
