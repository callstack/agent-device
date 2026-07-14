/**
 * ADR 0012 decision 6, R2/R3, extended per #1262: behaviors introduced
 * alongside the `resume.from` / `repairHint` agreement fix
 * (`session-replay-resume.ts`).
 *
 * 1. A `record-and-heal` divergence on the plan's LAST step reports
 *    `resume.from = actions.length + 1` — a legal EMPTY-TAIL resume, not an
 *    out-of-range error. The runtime must execute zero steps and reach the
 *    normal end-of-plan completion path, flipping the repair transaction
 *    COMPLETE so `close --save-script` actually commits the healed script
 *    instead of discarding it (rejecting this `--from` would force the agent
 *    into `close` on an INCOMPLETE transaction, which aborts with no publish).
 * 2. `pendingRecordAndHeal` rejects a `--from` continuation that lands
 *    exactly on that reported target with NO new action recorded since the
 *    divergence — proof the agent never performed the corrective press —
 *    instead of silently resuming past the unrepaired step.
 * 3. #1262: `caution`/`manual` are genuinely dual-path. Their OWN
 *    `resume.from` stays AT the failed step unconditionally (never shifted,
 *    never made illegal — items 1/2 above still apply verbatim once resumed
 *    there), but they ALSO get the SAME `actions.length + 1` empty-tail
 *    authorization (gated behind the SAME recorded-corrective-action proof)
 *    for their record-and-heal-shaped alternate repair, so a last-step
 *    `caution`/`manual` divergence is no longer a dead end.
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
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import { freshEvidence, makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';
import {
  bottomTabsRealCaptureFixture,
  recordArticleEvidence,
  toSnapshotNodes,
} from './session-replay-target-classification-fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  // The recorded container ("article", under a real nested ancestry chain)
  // stays present throughout — this is what routes the divergence to
  // `record-and-heal` rather than the `manual` fail-safe.
  mockDispatchCommand.mockResolvedValue({
    nodes: bottomTabsRealCaptureFixture(),
    truncated: false,
    backend: 'xctest',
  });
});

test('a record-and-heal divergence on the LAST step resumes with an empty tail and commits — but only after the corrective press is actually recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-empty-tail-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const evidence = recordArticleEvidence();
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    `# agent-device:target-v1 ${JSON.stringify(evidence)}`,
    'click id="article"',
  ]);

  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    failSteps: new Set(['click id="article"']),
  });

  // --- Leg 1: open records; "click id=article" fails at dispatch. The
  // recorded evidence's real ancestry + the still-present container routes
  // this to `record-and-heal`, and since it is the plan's LAST step,
  // resume.from = 3 = actions.length (2) + 1. ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    repairHint: string;
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.kind).toBe('action-failure');
  expect(divergence.repairHint).toBe('record-and-heal');
  expect(divergence.resume.allowed).toBe(true);
  expect(divergence.resume.from).toBe(3);

  const session = sessionStore.get(sessionName)!;
  expect(session.actions.map((a) => a.command)).toEqual(['open']);
  expect(session.saveScriptComplete).toBeFalsy();

  // --- A blind resume at the reported target BEFORE performing the
  // corrective press is rejected: no new action was recorded since the
  // divergence, so nothing proves the diverged step was actually repaired. ---
  const blindResume = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: {
        saveScript: true,
        replayFrom: divergence.resume.from,
        replayPlanDigest: divergence.resume.planDigest,
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(blindResume.ok).toBe(false);
  if (!blindResume.ok) {
    expect(blindResume.error.code).toBe('INVALID_ARGS');
    expect(blindResume.error.message).toMatch(/no corrective action/);
  }
  // Rejected before touching the plan at all — never re-diverges on "click".
  expect(session.actions.map((a) => a.command)).toEqual(['open']);

  // --- Agent performs the corrective press (blessed @ref), recorded live. ---
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e6'],
    flags: {},
    result: { selectorChain: ['id="article-v2"'] },
    targetEvidence: freshEvidence('article-v2', 'Article V2'),
  });

  // --- Leg 2: the SAME --from now succeeds — the corrective press grew
  // session.actions, consuming the watermark. Zero steps execute (there is
  // nothing left in the plan), and the runtime's normal end-of-plan path
  // flips the transaction COMPLETE. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: {
        saveScript: true,
        replayFrom: divergence.resume.from,
        replayPlanDigest: divergence.resume.planDigest,
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);
  if (leg2.ok) {
    expect((leg2.data as { replayed: number }).replayed).toBe(0);
  }
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press']);
  expect(session.saveScriptComplete).toBe(true);

  // --- Commit: the transaction is COMPLETE, so the healed script actually
  // publishes — the corrective press survives, "click" (never recorded) does
  // not. Proves the empty-tail resume did not lead to a discarded repair. ---
  const writeResult = sessionStore.writeSessionLog(session);
  expect(writeResult.written).toBe(true);
  const healedPath = path.join(root, 'flow.healed.ad');
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  expect(healedScript).toContain('open');
  expect(healedScript).toContain('article-v2');
  expect(healedScript).not.toMatch(/^click /m);
});

// --- #1262: `caution`/`manual` are genuinely dual-path — their OWN
// `resume.from` stays AT the failed step (N) unconditionally (never shifted,
// never made illegal), but they ALSO have a record-and-heal-shaped alternate
// repair (the agent performs the diverged step's intent as a recorded action
// instead), reachable at `--from N + 1`. `stampPendingRecordAndHealWatermark`
// now stamps the SAME empty-tail watermark for these hints, gated behind the
// SAME recorded-corrective-action proof, so a last-step `caution`/`manual`
// divergence is no longer a dead end (#1260 fixed this only for
// `record-and-heal`). ---

test('a manual divergence (unannotated action-failure) on the LAST step resumes with an empty tail and commits — but only after the corrective press is actually recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-empty-tail-manual-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  // No target-v1 annotation: an unannotated action-failure always routes to
  // the `manual` fail-safe (no recorded targetEvidence).
  const filePath = writeReplayFile(root, ['open "Demo" --relaunch', 'click label="Save"']);

  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    failSteps: new Set(['click label="Save"']),
  });

  // --- Leg 1: open records; "click label=Save" fails at dispatch with no
  // recorded target evidence, routing to `manual`. It is the plan's LAST
  // step, so the record-and-heal-shaped alternate target is 3 = actions
  // (2) + 1 — but `resume.from` itself stays at 2, unshifted. ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    repairHint: string;
    resume: { allowed: boolean; from: number; planDigest: string; alternateFrom?: number };
  };
  expect(divergence.kind).toBe('action-failure');
  expect(divergence.repairHint).toBe('manual');
  expect(divergence.resume.allowed).toBe(true);
  expect(divergence.resume.from).toBe(2);
  // #1262: the wire carries the record-and-heal-shaped alternate (N + 1 = 3)
  // — the diverged step is skip-safe, so `--from 3` would be accepted.
  expect(divergence.resume.alternateFrom).toBe(3);

  const session = sessionStore.get(sessionName)!;
  expect(session.actions.map((a) => a.command)).toEqual(['open']);
  expect(session.saveScriptComplete).toBeFalsy();
  // The watermark IS now stamped for `manual` (#1262) — targeting N + 1 (3),
  // a DIFFERENT ordinal than the unshifted `resume.from` (2) above.
  expect(session.pendingRecordAndHeal).toEqual({ expectedFrom: 3, actionsCountAtDivergence: 1 });

  // --- A blind resume at the empty-tail target BEFORE performing the
  // corrective press is rejected: no new action was recorded since the
  // divergence, so nothing proves the diverged step's intent was actually
  // performed. ---
  const blindResume = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(blindResume.ok).toBe(false);
  if (!blindResume.ok) {
    expect(blindResume.error.code).toBe('INVALID_ARGS');
    expect(blindResume.error.message).toMatch(/no corrective action/);
  }
  expect(session.actions.map((a) => a.command)).toEqual(['open']);

  // --- Agent performs the step's intent as a recorded action (blessed
  // @ref), recorded live. ---
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e6'],
    flags: {},
    result: { selectorChain: ['label="Save"'] },
    targetEvidence: freshEvidence('save-v2', 'Save'),
  });

  // --- Leg 2: the SAME `--from 3` now succeeds — the corrective press grew
  // session.actions, consuming the watermark. Zero steps execute, and the
  // runtime's normal end-of-plan path flips the transaction COMPLETE. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);
  if (leg2.ok) {
    expect((leg2.data as { replayed: number }).replayed).toBe(0);
  }
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press']);
  expect(session.saveScriptComplete).toBe(true);

  // --- Commit: the transaction is COMPLETE, so the healed script actually
  // publishes — the corrective press survives, "click" (never recorded,
  // since a `manual` divergence never dispatched it) does not. Proves the
  // empty-tail resume did not lead to a discarded repair (the #1260
  // discard-at-close trap, now also closed for `manual`). ---
  const writeResult = sessionStore.writeSessionLog(session);
  expect(writeResult.written).toBe(true);
  const healedPath = path.join(root, 'flow.healed.ad');
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  expect(healedScript).toContain('open');
  expect(healedScript).toContain('save-v2');
  expect(healedScript).not.toMatch(/^click /m);
});

test('a caution (identity-mismatch) divergence on the LAST step resumes with an empty tail and commits — but only after the corrective press is actually recorded', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-empty-tail-caution-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const SAVE_ANNOTATION =
    '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click label="Save"',
  ]);

  // The pre-action verification capture finds a node with the recorded
  // LABEL but a renamed id — a genuine identity-mismatch (matchCount 1),
  // never reaching dispatch for "click".
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save-v2',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName });

  // --- Leg 1: open records; "click label=Save" diverges pre-action as
  // identity-mismatch/`caution`. It is the plan's LAST step, so the
  // record-and-heal-shaped alternate target is 3 = actions (2) + 1 — but
  // `resume.from` itself stays at 2, unshifted (#1262 item 1). ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    repairHint: string;
    resume: { allowed: boolean; from: number; planDigest: string; alternateFrom?: number };
  };
  expect(divergence.kind).toBe('identity-mismatch');
  expect(divergence.repairHint).toBe('caution');
  expect(divergence.resume.allowed).toBe(true);
  expect(divergence.resume.from).toBe(2);
  // #1262: the wire carries the record-and-heal-shaped alternate (N + 1 = 3).
  expect(divergence.resume.alternateFrom).toBe(3);

  const session = sessionStore.get(sessionName)!;
  expect(session.actions.map((a) => a.command)).toEqual(['open']);
  expect(session.saveScriptComplete).toBeFalsy();
  expect(session.pendingRecordAndHeal).toEqual({ expectedFrom: 3, actionsCountAtDivergence: 1 });

  // --- A blind resume at the empty-tail target BEFORE performing the
  // corrective press is rejected. ---
  const blindResume = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(blindResume.ok).toBe(false);
  if (!blindResume.ok) {
    expect(blindResume.error.code).toBe('INVALID_ARGS');
    expect(blindResume.error.message).toMatch(/no corrective action/);
  }
  expect(session.actions.map((a) => a.command)).toEqual(['open']);

  // --- Agent presses the actual (renamed) control via a blessed @ref,
  // recorded live — the record-and-heal-shaped repair for path (a) from
  // #1262 ("selector binds the wrong node on the right screen"). ---
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e6'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save'),
  });

  // --- Leg 2: the SAME `--from 3` now succeeds — zero steps execute, and
  // the runtime's normal end-of-plan path flips the transaction COMPLETE. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);
  if (leg2.ok) {
    expect((leg2.data as { replayed: number }).replayed).toBe(0);
  }
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press']);
  expect(session.saveScriptComplete).toBe(true);

  // --- Commit: COMPLETE, so the healed script publishes the corrective
  // press; the pre-action "click" (never dispatched) does not appear. ---
  const writeResult = sessionStore.writeSessionLog(session);
  expect(writeResult.written).toBe(true);
  const healedPath = path.join(root, 'flow.healed.ad');
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  expect(healedScript).toContain('open');
  expect(healedScript).toContain('save-v2');
  expect(healedScript).not.toMatch(/^click /m);
});

test('--from N stays legal for a caution divergence even after the N + 1 empty-tail watermark is stamped', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-empty-tail-caution-from-n-'),
  );
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const SAVE_ANNOTATION =
    '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click label="Save"',
  ]);

  // Leg 1's capture: a genuine identity-mismatch (renamed id, same label).
  mockDispatchCommand.mockResolvedValueOnce({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save-v2',
        label: 'Save',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName });

  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as {
    repairHint: string;
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.repairHint).toBe('caution');
  expect(divergence.resume.from).toBe(2);
  const session = sessionStore.get(sessionName)!;
  // The N + 1 watermark is stamped (path (a) is available)...
  expect(session.pendingRecordAndHeal).toEqual({ expectedFrom: 3, actionsCountAtDivergence: 1 });

  // --- ...but path (b) — a `--no-record` app-state fix, then resuming AT
  // the unshifted `resume.from` (N = 2) — must stay unconditionally legal:
  // the watermark for the N + 1 alternate must never make N itself illegal.
  // The recorded-corrective-action guard only ever matches `expectedFrom`
  // (3), never N, so this request sails through the entry-index checks
  // straight to re-running "click" — this time against a capture where the
  // recorded id is present again (the state fix), so it verifies and
  // dispatches for real. ---
  mockDispatchCommand.mockResolvedValueOnce({
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
  const resumeAtN = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: {
        saveScript: true,
        replayFrom: divergence.resume.from,
        replayPlanDigest: divergence.resume.planDigest,
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(resumeAtN.ok).toBe(true);
  if (resumeAtN.ok) {
    expect((resumeAtN.data as { replayed: number }).replayed).toBe(1);
  }
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'click']);
  expect(session.saveScriptComplete).toBe(true);
});

test('an unauthorized --from one past the plan end is rejected on an ARMED session whose last-step divergence hint is state-repair, not record-and-heal', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-empty-tail-state-repair-'),
  );
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const evidence = recordArticleEvidence();
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    `# agent-device:target-v1 ${JSON.stringify(evidence)}`,
    'click id="article"',
  ]);

  // The pre-action verification capture is a COMPLETELY unrelated screen —
  // "article" resolves to matchCount 0 (selector-miss) AND the recorded
  // container itself is absent (not merely the leaf), so this routes to
  // `state-repair` (the app-state sub-flow), never `record-and-heal`. No
  // `pendingRecordAndHeal` watermark is ever stamped for this session.
  mockDispatchCommand.mockResolvedValue({
    nodes: toSnapshotNodes([
      {
        index: 0,
        type: 'Application',
        label: 'Unrelated Screen',
        rect: { x: 0, y: 0, width: 100, height: 100 },
        depth: 0,
      },
    ]),
    truncated: false,
    backend: 'xctest',
  });

  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName });

  // --- The armed session diverges pre-action (target verification), never
  // reaching `invoke` for "click" — this is the SAME repair-armed
  // (`--save-script`) lifecycle a record-and-heal repair uses, just a
  // different repair sub-flow. ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    repairHint: string;
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.kind).toBe('selector-miss');
  expect(divergence.repairHint).toBe('state-repair');
  // `state-repair` never shifts `from` — it stays AT the failed step (2).
  expect(divergence.resume.from).toBe(2);
  const session = sessionStore.get(sessionName)!;
  expect(session.pendingRecordAndHeal).toBeUndefined();
  expect(session.saveScriptBoundary).toBeDefined(); // genuinely armed

  // --- Exploit attempt: `--from 3` (one past the plan's end) — exactly the
  // ordinal a record-and-heal empty-tail resume would use — on an armed
  // session whose divergence hint is `state-repair`. Must be rejected: no
  // record-and-heal watermark authorizes skipping the unresolved final step,
  // regardless of how the session's OTHER lifecycle state (armed/held)
  // looks. ---
  const exploitAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(exploitAttempt.ok).toBe(false);
  if (!exploitAttempt.ok) {
    expect(exploitAttempt.error.code).toBe('INVALID_ARGS');
    expect(exploitAttempt.error.message).toMatch(/out of range/);
  }
  expect(session.saveScriptComplete).toBeFalsy();
});

test('a stale --plan-digest on an empty-tail resume is rejected WITHOUT consuming the watermark, so a subsequent correct retry still succeeds', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-empty-tail-digest-retry-'),
  );
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const evidence = recordArticleEvidence();
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    `# agent-device:target-v1 ${JSON.stringify(evidence)}`,
    'click id="article"',
  ]);

  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    failSteps: new Set(['click id="article"']),
  });

  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as {
    repairHint: string;
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.repairHint).toBe('record-and-heal');
  expect(divergence.resume.from).toBe(3);

  const session = sessionStore.get(sessionName)!;
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e6'],
    flags: {},
    result: { selectorChain: ['id="article-v2"'] },
    targetEvidence: freshEvidence('article-v2', 'Article V2'),
  });
  expect(session.pendingRecordAndHeal).toBeDefined();

  // --- A resume at the correct `from` but a STALE digest is rejected — the
  // watermark must NOT be consumed here, or a legitimate retry with the
  // correct digest would find it already cleared and get rejected as
  // out-of-range, permanently locking the agent out of completing the
  // repair. ---
  const staleDigestAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: {
        saveScript: true,
        replayFrom: divergence.resume.from,
        replayPlanDigest: 'stale-digest-does-not-match',
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(staleDigestAttempt.ok).toBe(false);
  if (!staleDigestAttempt.ok) {
    expect(staleDigestAttempt.error.code).toBe('INVALID_ARGS');
    expect(staleDigestAttempt.error.message).toMatch(/plan digest/);
  }
  // The watermark survives the rejected leg untouched.
  expect(session.pendingRecordAndHeal).toEqual({
    expectedFrom: divergence.resume.from,
    actionsCountAtDivergence: 1,
  });

  // --- The retry with the CORRECT digest still succeeds — never locked out. ---
  const retry = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: {
        saveScript: true,
        replayFrom: divergence.resume.from,
        replayPlanDigest: divergence.resume.planDigest,
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(retry.ok).toBe(true);
  expect(session.saveScriptComplete).toBe(true);
  expect(session.pendingRecordAndHeal).toBeUndefined();
});
