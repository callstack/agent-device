import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, test } from 'vitest';
import { INTERNAL_COMMANDS } from '../../../command-catalog.ts';
import { makeIosSession } from '../../../__tests__/test-utils/index.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, SessionState } from '../../types.ts';
import { handleSessionScriptPublication } from '../session-script-publication.ts';

const TARGET_EVIDENCE: TargetAnnotationV1 = {
  id: 'continue',
  role: 'button',
  label: 'Continue',
  ancestry: [],
  sibling: 0,
  viewportOrder: 0,
  verification: 'verified',
};

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-active-publication-'));
  store = new SessionStore(path.join(root, 'sessions'));
});

function armedSession(overrides: Partial<SessionState> = {}): SessionState {
  return makeIosSession('authoring', {
    recordSession: true,
    scriptRecordingState: 'armed',
    actions: [
      { ts: 1, command: 'open', positionals: ['Demo'], flags: { saveScript: true } },
      {
        ts: 2,
        command: 'press',
        positionals: ['id="continue"'],
        flags: {},
        targetEvidence: TARGET_EVIDENCE,
      },
      { ts: 3, command: 'wait', positionals: ['id="screen-x"'], flags: {} },
    ],
    ...overrides,
  });
}

function request(outputPath?: string, force?: boolean): DaemonRequest {
  return {
    token: 'test',
    session: 'authoring',
    command: INTERNAL_COMMANDS.sessionSaveScript,
    positionals: outputPath !== undefined ? [outputPath] : [],
    flags: force ? { force: true } : {},
  };
}

test('publishes without close, returns the path/count, and leaves a terminal live session', () => {
  const outputPath = path.join(root, 'screen-x.ad');
  const session = armedSession();
  store.set('authoring', session);

  const response = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });

  expect(response).toMatchObject({
    ok: true,
    data: { session: 'authoring', savedScript: outputPath, actionCount: 3 },
  });
  expect(fs.readFileSync(outputPath, 'utf8')).toContain('wait "id=\\"screen-x\\""');
  expect(fs.readFileSync(outputPath, 'utf8')).not.toContain('\nclose');
  expect(store.get('authoring')).toBe(session);
  expect(session.scriptRecordingState).toBe('published');
  expect(session.recordSession).toBe(false);

  const repeated = handleSessionScriptPublication({
    req: request(),
    sessionName: 'authoring',
    sessionStore: store,
  });
  expect(repeated).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/already/) },
  });
});

test('no-clobber failure preserves bytes and armed state, then --force retries successfully', () => {
  const outputPath = path.join(root, 'screen-x.ad');
  fs.writeFileSync(outputPath, 'original\n');
  const session = armedSession();
  store.set('authoring', session);

  const refused = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });
  expect(refused).toMatchObject({ ok: false, error: { retriable: true } });
  expect(fs.readFileSync(outputPath, 'utf8')).toBe('original\n');
  expect(session.scriptRecordingState).toBe('armed');
  expect(session.saveScriptPath).toBe(outputPath);

  const replaced = handleSessionScriptPublication({
    req: request(outputPath, true),
    sessionName: 'authoring',
    sessionStore: store,
  });
  expect(replaced?.ok).toBe(true);
  expect(fs.readFileSync(outputPath, 'utf8')).toContain('context platform=ios');
  expect(session.scriptRecordingState).toBe('published');
});

test('retargeting without --force clears force authorization from the previous target', () => {
  const originalPath = path.join(root, 'original.ad');
  const retargetPath = path.join(root, 'retarget.ad');
  fs.writeFileSync(retargetPath, 'protected\n');
  const session = armedSession({
    saveScriptPath: originalPath,
    saveScriptForce: true,
  });
  store.set('authoring', session);

  const response = handleSessionScriptPublication({
    req: request(retargetPath),
    sessionName: 'authoring',
    sessionStore: store,
  });

  expect(response).toMatchObject({ ok: false, error: { retriable: true } });
  expect(fs.readFileSync(retargetPath, 'utf8')).toBe('protected\n');
  expect(session.scriptRecordingState).toBe('armed');
  expect(session.saveScriptPath).toBe(retargetPath);
  expect(session.saveScriptForce).toBeUndefined();
});

test('refuses unarmed and repair-owned sessions before filesystem work', () => {
  const outputPath = path.join(root, 'missing', 'screen-x.ad');
  store.set('authoring', makeIosSession('authoring'));
  const unarmed = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });
  expect(unarmed).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/not armed/) },
  });
  expect(fs.existsSync(path.dirname(outputPath))).toBe(false);

  store.set('authoring', armedSession({ saveScriptBoundary: 0 }));
  const repair = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });
  expect(repair).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/repair transaction/) },
  });
  expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
});

test('rejects an explicitly empty destination path', () => {
  const session = armedSession();
  store.set('authoring', session);

  const response = handleSessionScriptPublication({
    req: request(''),
    sessionName: 'authoring',
    sessionStore: store,
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: expect.stringMatching(/path cannot be empty/) },
  });
  expect(session.scriptRecordingState).toBe('armed');
});

test('invalid destination guard remains armed and creates no target directory', () => {
  const outputPath = path.join(root, 'missing', 'screen-x.ad');
  const session = armedSession({
    actions: [
      { ts: 1, command: 'open', positionals: ['Demo'], flags: { saveScript: true } },
      { ts: 2, command: 'wait', positionals: ['stable'], flags: {} },
    ],
  });
  store.set('authoring', session);

  const response = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });
  expect(response).toMatchObject({
    ok: false,
    error: { message: expect.stringMatching(/destination guard/), retriable: true },
  });
  expect(session.scriptRecordingState).toBe('armed');
  expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
});

test('missing initial open is non-retriable within the armed session', () => {
  const outputPath = path.join(root, 'missing', 'screen-x.ad');
  const session = armedSession({
    actions: [{ ts: 1, command: 'wait', positionals: ['id="screen-x"'], flags: {} }],
  });
  store.set('authoring', session);

  const response = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      message: expect.stringMatching(/exactly one initial recorded open/),
      hint: expect.stringMatching(/start a fresh one/),
      retriable: false,
    },
  });
  expect(session.scriptRecordingState).toBe('armed');
  expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
});

test('publishes leading-at typed values without mistaking them for session refs', () => {
  const outputPath = path.join(root, 'social-handle.ad');
  const session = armedSession({
    actions: [
      { ts: 1, command: 'open', positionals: ['Demo'], flags: { saveScript: true } },
      { ts: 2, command: 'type', positionals: ['@thymikee'], flags: {} },
      {
        ts: 3,
        command: 'fill',
        positionals: ['id="handle"', '@someone'],
        flags: {},
        targetEvidence: TARGET_EVIDENCE,
      },
      {
        ts: 4,
        command: 'find',
        positionals: ['text', '@handle', 'get', 'text'],
        flags: {},
      },
      { ts: 5, command: 'wait', positionals: ['id="screen-x"'], flags: {} },
    ],
  });
  store.set('authoring', session);

  const response = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });

  expect(response?.ok).toBe(true);
  const script = fs.readFileSync(outputPath, 'utf8');
  expect(script).toContain('@thymikee');
  expect(script).toContain('@someone');
  expect(script).toContain('@handle');
});

test('refuses mutating find steps that cannot enforce target identity on replay', () => {
  const outputPath = path.join(root, 'missing', 'find-flow.ad');
  const session = armedSession({
    actions: [
      { ts: 1, command: 'open', positionals: ['Demo'], flags: { saveScript: true } },
      {
        ts: 2,
        command: 'find',
        positionals: ['text', 'Continue', 'click'],
        flags: {},
      },
      { ts: 3, command: 'wait', positionals: ['id="screen-x"'], flags: {} },
    ],
  });
  store.set('authoring', session);

  const response = handleSessionScriptPublication({
    req: request(outputPath),
    sessionName: 'authoring',
    sessionStore: store,
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      message: expect.stringMatching(/mutating find.*not replay-verifiable/),
      retriable: false,
    },
  });
  expect(fs.existsSync(path.dirname(outputPath))).toBe(false);
});
