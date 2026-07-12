/**
 * ADR 0012 decision 6: `replay --save-script` arming (R1), the repair-run
 * boundary watermark (R6, sticky across `--from` legs), `--from` ordering
 * with no prefix duplication (R2), the opt-in guarantee, and the
 * never-record-a-failed-step invariant the whole mechanism depends on.
 *
 * `invoke` is mocked, matching every other `session-replay-runtime*.test.ts`
 * file's convention — but here the mock ACTUALLY calls `sessionStore.recordAction`
 * (the same method the real command handlers call), so `session.actions`
 * accumulates for real instead of staying empty.
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
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  // Matches every step's recorded identity (id="save") — the target-binding
  // verification a couple of these scripts' annotated steps trigger.
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

function freshEvidence(id: string, label: string): TargetAnnotationV1 {
  return {
    id,
    role: 'button',
    label,
    ancestry: [],
    sibling: 0,
    viewportOrder: 0,
    verification: 'verified',
  };
}

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Recorded Original","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

test('R1/R2/R6: prefix steps get fresh evidence, corrective + resumed steps land in order, boundary stays sticky across a redundant --save-script leg', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-loop-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="delete"',
    'click id="confirm"',
  ]);

  let clickCalls = 0;
  const invoke = async (req: DaemonRequest): Promise<DaemonResponse> => {
    const session = sessionStore.get(sessionName)!;
    if (req.command === 'open') {
      sessionStore.recordAction(session, {
        command: 'open',
        positionals: req.positionals ?? [],
        flags: req.flags ?? {},
        runtime: req.runtime,
        result: {},
      });
      return { ok: true, data: {} };
    }
    if (req.command === 'click' && req.positionals?.[0] === 'id="delete"') {
      // Simulates the real handler: a dispatch failure never reaches the
      // recording call (interaction-common.ts's finalizeTouchInteraction is
      // only reached on the success path) — nothing is recorded here.
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'not hittable' } };
    }
    if (req.command === 'click') {
      clickCalls += 1;
      const targetEvidence = session.recordSession
        ? freshEvidence('save', `FRESH-${clickCalls}`)
        : undefined;
      sessionStore.recordAction(session, {
        command: 'click',
        positionals: req.positionals ?? [],
        flags: req.flags ?? {},
        result: {},
        ...(targetEvidence ? { targetEvidence } : {}),
      });
      return { ok: true, data: {} };
    }
    return { ok: true, data: {} };
  };

  // --- Leg 1: arms recording, records open + the verified prefix step, then
  // diverges (action-failure) at "click id=delete" — never recorded. ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
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

  // --- Agent performs the corrective action live (ordinary interactive
  // command, outside replay) — lands next in session.actions. ---
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e9'],
    flags: {},
    result: { selectorChain: ['id="delete-v2"'] },
    targetEvidence: freshEvidence('delete-v2', 'Delete V2'),
  });
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'click', 'press']);

  // --- Leg 2: resumes at step 4, redundantly passing --save-script again —
  // must NOT re-stamp the boundary or duplicate the already-recorded prefix. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: {
        saveScript: true,
        replayFrom: 4,
        replayPlanDigest: divergence.resume.planDigest,
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
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

  // The healed slice (boundary 0) spans the WHOLE repair run across both legs.
  const healedSlice = session.actions.slice(session.saveScriptBoundary ?? 0);
  expect(healedSlice).toHaveLength(4);
});

test('opt-in: without --save-script, replay neither arms recording nor records evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-optin-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);

  const invoke = async (req: DaemonRequest): Promise<DaemonResponse> => {
    const session = sessionStore.get(sessionName)!;
    const targetEvidence = session.recordSession ? freshEvidence('save', 'Save') : undefined;
    sessionStore.recordAction(session, {
      command: req.command,
      positionals: req.positionals ?? [],
      flags: req.flags ?? {},
      result: {},
      ...(targetEvidence ? { targetEvidence } : {}),
    });
    return { ok: true, data: {} };
  };

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
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

test('a thrown dispatch failure never lands a partial action in session.actions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-thrown-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);

  const invoke = async (req: DaemonRequest): Promise<DaemonResponse> => {
    const session = sessionStore.get(sessionName)!;
    if (req.command === 'click') {
      // The real interaction handler's catch converts a thrown selector-miss
      // into `{ ok: false }` WITHOUT ever calling finalizeTouchInteraction —
      // nothing gets recorded on this path.
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'no such element' } };
    }
    sessionStore.recordAction(session, {
      command: req.command,
      positionals: req.positionals ?? [],
      flags: req.flags ?? {},
      result: {},
    });
    return { ok: true, data: {} };
  };

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response.ok).toBe(false);
  const session = sessionStore.get(sessionName)!;
  expect(session.actions.map((a) => a.command)).toEqual(['open']);
});

test('a --no-record state-fix action never enters session.actions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-norecord-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const session = makeIosSession(sessionName, { recordSession: true, saveScriptBoundary: 0 });
  sessionStore.set(sessionName, session);

  // Agent fixes app state with --no-record, then performs the real
  // corrective action (recorded).
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
  expect(session.actions[0]?.command).toBe('press');
  expect(session.actions[0]?.positionals).toEqual(['@e9']);
});

test('R1 bootstrap: a session created by step 1 (open) still arms in time for step 2 to get fresh evidence', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-bootstrap-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  // No pre-existing session — `open` (step 1) creates it.
  const filePath = writeReplayFile(root, ['open "Demo"', 'click id="save"']);

  const invoke = async (req: DaemonRequest): Promise<DaemonResponse> => {
    if (req.command === 'open') {
      sessionStore.set(sessionName, makeIosSession(sessionName));
      const session = sessionStore.get(sessionName)!;
      sessionStore.recordAction(session, {
        command: 'open',
        positionals: req.positionals ?? [],
        flags: req.flags ?? {},
        result: {},
      });
      return { ok: true, data: {} };
    }
    const session = sessionStore.get(sessionName)!;
    const targetEvidence = session.recordSession ? freshEvidence('save', 'Save') : undefined;
    sessionStore.recordAction(session, {
      command: req.command,
      positionals: req.positionals ?? [],
      flags: req.flags ?? {},
      result: {},
      ...(targetEvidence ? { targetEvidence } : {}),
    });
    return { ok: true, data: {} };
  };

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
