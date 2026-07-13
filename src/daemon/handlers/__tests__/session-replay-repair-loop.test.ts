/**
 * ADR 0012 decision 6: `replay --save-script` arming (R1), the repair-run
 * boundary watermark (R6, sticky across `--from` legs, no amputation when
 * step-1 `open` replaces the session), `--from` ordering with no prefix
 * duplication (R2, including the fresh-full-replay rejection), the opt-in
 * guarantee, and the never-record-a-failed-step invariant.
 *
 * The mock `invoke` ACTUALLY records via `sessionStore.recordAction` (the same
 * call the real handlers make), through `makeRecordingReplayInvoke`, so
 * `session.actions` accumulates for real instead of staying empty.
 */
import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { SessionStore } from '../../session-store.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import type { DaemonRequest } from '../../types.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import { freshEvidence, makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  // Matches every annotated step's recorded identity (id="save") — the
  // target-binding verification a couple of these scripts trigger.
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
});

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Recorded Original","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

function setup(prefix: string, sessionOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, sessionOverrides));
  return { root, sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

test('R1/R2/R6: prefix steps get fresh evidence, corrective + resumed steps land in order, boundary stays sticky across a --from --save-script leg', async () => {
  const { root, sessionStore, sessionName, logPath } = setup('agent-device-replay-repair-loop-', {
    appBundleId: 'com.example.app',
  });
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="delete"',
    'click id="confirm"',
  ]);

  let clickCalls = 0;
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    // "click id=delete" diverges (action-failure) and must never be recorded.
    failSteps: new Set(['click id="delete"']),
    evidence: (req) =>
      req.command === 'click' ? freshEvidence('save', `FRESH-${++clickCalls}`) : undefined,
  });

  // --- Leg 1: arms recording, records open + the verified prefix step, then
  // diverges at "click id=delete" — never recorded. ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const session = sessionStore.get(sessionName)!;
  expect(session.recordSession).toBe(true);
  expect(session.saveScriptBoundary).toBe(0);
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'click']);
  // R1: the recorded prefix step carries FRESH evidence, never the .ad's own
  // "Recorded Original" annotation copied through.
  expect(session.actions[1]?.targetEvidence?.label).toBe('FRESH-1');
  const divergence = leg1.error.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.resume.allowed).toBe(true);
  expect(divergence.resume.from).toBe(3);

  // --- Agent performs the corrective action live (recorded). ---
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e9'],
    flags: {},
    result: { selectorChain: ['id="delete-v2"'] },
    targetEvidence: freshEvidence('delete-v2', 'Delete V2'),
  });
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'click', 'press']);

  // --- Leg 2: a --from resume that redundantly passes --save-script — allowed
  // (it is a resume, not a full replay), and must NOT re-stamp the boundary. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 4, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);

  expect(session.saveScriptBoundary).toBe(0); // sticky — NOT reset to 3
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'click', 'press', 'click']);
  expect(session.actions.map((a) => a.positionals[0])).toEqual([
    'Demo',
    'id="save"',
    '@e9',
    'id="confirm"',
  ]);
  expect(session.actions.slice(session.saveScriptBoundary ?? 0)).toHaveLength(4);
});

test('R2: a fresh FULL replay --save-script on an already-armed session is rejected with INVALID_ARGS', async () => {
  const { root, sessionStore, sessionName, logPath } = setup('agent-device-replay-repair-r2-');
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);
  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName });

  // First run arms the session (sets saveScriptBoundary).
  const first = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(first.ok).toBe(true);
  expect(sessionStore.get(sessionName)!.saveScriptBoundary).toBe(0);

  // A SECOND full (non---from) replay --save-script would re-append the prefix.
  const spy: DaemonRequest[] = [];
  const second = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke: makeRecordingReplayInvoke({ sessionStore, sessionName, spy }),
  });
  expect(second.ok).toBe(false);
  if (second.ok) return;
  expect(second.error.code).toBe('INVALID_ARGS');
  expect(second.error.message).toMatch(/active --save-script repair run/);
  // Rejected before any action ran — no duplicate prefix appended.
  expect(spy).toHaveLength(0);
});

test('R2 bypass guard: a PLAIN full replay (no --save-script) on an armed session is still rejected', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-replay-repair-r2-plain-',
  );
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);

  // Arm the repair run — session stays repair-armed (recordSession +
  // saveScriptBoundary) after it returns.
  const first = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke: makeRecordingReplayInvoke({ sessionStore, sessionName }),
  });
  expect(first.ok).toBe(true);
  const armed = sessionStore.get(sessionName)!;
  expect(armed.saveScriptBoundary).toBe(0);
  expect(armed.recordSession).toBe(true);
  const armedActionCount = armed.actions.length;

  // A plain full replay WITHOUT --save-script must NOT bypass R2: recordSession
  // is still true, so it would re-append the prefix. Reject it, zero dispatches,
  // healed slice not duplicated.
  const spy: DaemonRequest[] = [];
  const plain = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath,
    sessionStore,
    invoke: makeRecordingReplayInvoke({ sessionStore, sessionName, spy }),
  });
  expect(plain.ok).toBe(false);
  if (plain.ok) return;
  expect(plain.error.code).toBe('INVALID_ARGS');
  expect(plain.error.message).toMatch(/active --save-script repair run/);
  expect(spy).toHaveLength(0);
  // No prefix duplication: the armed session's actions are unchanged.
  expect(sessionStore.get(sessionName)!.actions.length).toBe(armedActionCount);
});

test('R6 no amputation: a pre-populated session whose step-1 open REPLACES the session healed-slices exactly this run', async () => {
  // Pre-seed with 2 prior, unrelated actions.
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-replay-repair-amputate-',
    {
      actions: [
        { ts: 1, command: 'wait', positionals: ['10'], flags: {} },
        { ts: 2, command: 'wait', positionals: ['20'], flags: {} },
      ],
    },
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    'click id="a"',
    'click id="b"',
  ]);

  // open REPLACES the session with a fresh `actions: []` one (the real
  // new-session branch, session-open-surface.ts) — the case the old pre-loop
  // boundary=N would amputate (slice(2) drops the healed open + first click).
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    openReplacesSession: true,
    evidence: (req) => (req.command === 'click' ? freshEvidence('x', 'X') : undefined),
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(response.ok).toBe(true);

  const session = sessionStore.get(sessionName)!;
  // The healed slice is EXACTLY this run (open + both clicks) — the open is not
  // amputated, and the prior waits (on the discarded session) never leak in.
  const healed = session.actions.slice(session.saveScriptBoundary ?? 0);
  expect(healed.map((a) => a.command)).toEqual(['open', 'click', 'click']);
  expect(healed[0]?.positionals[0]).toBe('Demo');
  expect(session.actions.some((a) => a.command === 'wait')).toBe(false);
});

test('R6 preserved session: prior actions are excluded from the healed slice', async () => {
  // open PRESERVES the session (existing-session branch keeps actions), so the
  // boundary must be N to exclude the 2 prior actions.
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-replay-repair-preserve-',
    {
      actions: [
        { ts: 1, command: 'wait', positionals: ['10'], flags: {} },
        { ts: 2, command: 'wait', positionals: ['20'], flags: {} },
      ],
    },
  );
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="a"']);
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('a', 'A') : undefined),
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(response.ok).toBe(true);

  const session = sessionStore.get(sessionName)!;
  expect(session.saveScriptBoundary).toBe(2);
  expect(session.actions.map((a) => a.command)).toEqual(['wait', 'wait', 'open', 'click']);
  const healed = session.actions.slice(session.saveScriptBoundary ?? 0);
  expect(healed.map((a) => a.command)).toEqual(['open', 'click']);
});

test('opt-in: without --save-script, replay neither arms recording nor records evidence', async () => {
  const { root, sessionStore, sessionName, logPath } = setup('agent-device-replay-repair-optin-');
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: () => freshEvidence('save', 'Save'),
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const data = response.data as { replayed: number; message: string };
  expect(data.replayed).toBe(2);
  expect(data.message).toMatch(/^Replayed 2 steps in \d+\.\ds$/);

  const session = sessionStore.get(sessionName)!;
  expect(session.recordSession).toBeFalsy();
  expect(session.saveScriptBoundary).toBeUndefined();
  expect(session.saveScriptPath).toBeUndefined();
  expect(session.actions.every((a) => a.targetEvidence === undefined)).toBe(true);
});

test('a thrown/failed dispatch never lands a partial action in session.actions', async () => {
  const { root, sessionStore, sessionName, logPath } = setup('agent-device-replay-repair-thrown-');
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    failSteps: new Set(['click']),
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });

  expect(response.ok).toBe(false);
  expect(sessionStore.get(sessionName)!.actions.map((a) => a.command)).toEqual(['open']);
});

test('a --no-record state-fix action never enters session.actions', () => {
  const { sessionStore, sessionName } = setup('agent-device-replay-repair-norecord-', {
    recordSession: true,
    saveScriptBoundary: 0,
  });
  const session = sessionStore.get(sessionName)!;

  // Agent fixes app state with --no-record, then performs the real corrective
  // action (recorded).
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['100', '200'],
    flags: { noRecord: true },
    result: {},
  });
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e9'],
    flags: {},
    result: { selectorChain: ['id="save"'] },
    targetEvidence: freshEvidence('save', 'Save'),
  });

  expect(session.actions).toHaveLength(1);
  expect(session.actions[0]?.positionals).toEqual(['@e9']);
});

test('R1 bootstrap: a session created by step 1 (open) arms in time for step 2 to get fresh evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-bootstrap-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  // No pre-existing session — `open` (step 1) creates it.
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('save', 'Save') : undefined),
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response.ok).toBe(true);
  const session = sessionStore.get(sessionName)!;
  expect(session.recordSession).toBe(true);
  expect(session.saveScriptBoundary).toBe(0);
  expect(session.actions[1]?.targetEvidence).toBeDefined();
});
