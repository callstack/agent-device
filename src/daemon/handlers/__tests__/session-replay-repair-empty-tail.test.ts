/**
 * ADR 0012 decision 6, R2/R3: two behaviors introduced alongside the
 * `resume.from` / `repairHint` agreement fix (`session-replay-resume.ts`).
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

test('a --from one past the plan end is rejected as out of range when no record-and-heal watermark authorizes it', async () => {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-empty-tail-unauthorized-'),
  );
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  // No target-v1 annotation: an unannotated action-failure always routes to
  // the `manual` fail-safe (no recorded targetEvidence), so NO
  // `pendingRecordAndHeal` watermark is ever stamped for this divergence.
  const filePath = writeReplayFile(root, ['open "Demo" --relaunch', 'click label="Save"']);

  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    failSteps: new Set(['click label="Save"']),
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
  expect(divergence.repairHint).toBe('manual');
  // `from` stays AT the failed step (2) — never shifted, since only
  // `record-and-heal` shifts `from`. The plan has 2 actions, so `--from 3`
  // (one past the end) is what an EMPTY-TAIL resume would use — but this
  // session never authorized it.
  expect(divergence.resume.from).toBe(2);
  const session = sessionStore.get(sessionName)!;
  expect(session.pendingRecordAndHeal).toBeUndefined();

  // --- A caller crafts `--from 3` directly — exactly the one-past-the-end
  // ordinal a record-and-heal empty-tail resume would use, but with no
  // matching watermark on this session. Must be rejected as out of range,
  // never silently executed with zero steps (which would let `close`
  // commit while the actual final "click" step remains unresolved). ---
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
