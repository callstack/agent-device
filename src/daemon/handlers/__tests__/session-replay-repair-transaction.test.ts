/**
 * ADR 0012 decision 6 "repair transaction" lifecycle fixes (Q1/Q2a/Q2b/Q2c):
 * proves the WHOLE chain end to end, at the layer these fixes actually live —
 * `runReplayScriptFile` + `handleCloseCommand` sharing a live `SessionStore`,
 * exactly like an agent's separate CLI invocations against the same daemon
 * session would. `sendToDaemon`'s process-level keep-alive (Fix 1's daemon
 * teardown guard) is a different architectural layer — a client-side process
 * manager, not session/script state — and is covered separately in
 * `src/utils/__tests__/daemon-client-lifecycle.test.ts`
 * ("keeps an owned ephemeral daemon alive and hints its --state-dir...").
 *
 * Fix 1 (session-side): a divergence never deletes the session — it stays in
 * the SessionStore, addressable for the next call.
 * Fix 2: SessionScriptWriter.write only publishes once `close --save-script`
 * sets `saveScriptComplete` — never on a divergence-only exit or an
 * abandoned close.
 * Fix 3: the source plan's terminal `close` is skipped while repair-armed, so
 * the resume completes instead of diverging on lifecycle.
 * Fix 4: the publish is atomic (temp + rename) and carries the completeness
 * sentinel, so a stale/partial file never blocks a later repair.
 */
import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../platforms/apple/core/simulator.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/simulator.ts')>();
  return { ...actual, shutdownSimulator: vi.fn() };
});
vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return { ...actual, stopIosRunnerSession: vi.fn(async () => {}) };
});
vi.mock('../../../platforms/apple/core/perf-xctrace.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/perf-xctrace.ts')>();
  return { ...actual, cleanupAppleXctracePerfCapture: vi.fn(async () => ({})) };
});
vi.mock('../../runtime-hints.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtime-hints.ts')>();
  return { ...actual, clearRuntimeHintsFromApp: vi.fn(async () => {}) };
});
vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});
vi.mock('../session-device-utils.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../session-device-utils.ts')>();
  return { ...actual, settleIosSimulator: vi.fn(async () => {}) };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { handleCloseCommand } from '../session-close.ts';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { AppError } from '../../../kernel/errors.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { HEAL_COMPLETE_SENTINEL } from '../../session-script-writer.ts';
import { parseReplayScriptDetailed } from '../../../replay/script.ts';
import type { DaemonRequest } from '../../types.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import { freshEvidence, makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  // The "current" app state: "save" was renamed to "save-v2" (why step 2
  // diverges), matching the target verification the SAVE_ANNOTATION triggers.
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save-v2',
        label: 'Save V2',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
});

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

function setup(prefix: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return {
    root,
    sessionStore,
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    leaseRegistry: new LeaseRegistry(),
  };
}

test('end-to-end repair transaction: cold divergence stays alive, corrective resume completes, close --save-script finalizes a COMPLETE healed .ad atomically, and an abandoned repair leaves no partial file', async () => {
  // ============================================================
  // Part 1 — the repair chain that COMMITS.
  // ============================================================
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-commit-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });

  // --- Cold `replay drifted.ad --save-script` diverges on the renamed id. ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  expect(leg1.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    resume: { allowed: boolean; from: number; planDigest: string; repairSessionHeld?: boolean };
  };
  expect(divergence.kind).toBe('selector-miss');
  expect(divergence.resume.allowed).toBe(true);
  // C1: the daemon marks the repair-transaction liveness signal on the wire.
  expect(divergence.resume.repairSessionHeld).toBe(true);

  // Fix 1 (session-side): the session stays alive — never torn down on a
  // divergence-only exit. (The client-side daemon PROCESS keep-alive that
  // makes this session reachable across separate CLI invocations is proven
  // in daemon-client-lifecycle.test.ts.)
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(sessionStore.get(sessionName)!.actions.map((a) => a.command)).toEqual(['open']);
  // C2: the transaction is NOT complete yet — a `close` here would abort, not
  // commit a prefix.
  expect(sessionStore.get(sessionName)!.saveScriptComplete).toBeFalsy();

  // --- Agent performs the corrective press (blessed @ref), recorded live. ---
  const session = sessionStore.get(sessionName)!;
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });

  // --- `replay --from N+1 --plan-digest <original>` resumes to the end. The
  // source plan's own terminal `close` (Fix 3) is skipped, so this completes
  // instead of diverging on lifecycle. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press', 'click']);
  // The terminal close never dispatched or recorded.
  expect(session.actions.some((a) => a.command === 'close')).toBe(false);
  // C2: the resume reached the last executable step (terminal close skipped) —
  // the transaction is now COMPLETE and commit-eligible.
  expect(session.saveScriptComplete).toBe(true);

  // --- The agent finalizes: `close --save-script` (the real handler, not a
  // direct writer call) commits the now-COMPLETE healed `.ad`. ---
  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: true },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(closeResponse.ok).toBe(true);
  // The session is gone (close's normal lifecycle) — but the healed script
  // was written to disk before deletion.
  expect(sessionStore.get(sessionName)).toBeUndefined();

  const healedPath = path.join(root, 'flow.healed.ad');
  // BLOCKER 2a: the close response positively reports the committed healed path.
  if (closeResponse.ok) expect(closeResponse.data?.savedScript).toBe(healedPath);
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  // Fix 4: complete + atomic — the sentinel is present, and the only file in
  // the directory is the final published one (no stray temp file survived).
  expect(healedScript).toContain(HEAL_COMPLETE_SENTINEL);
  expect(fs.readdirSync(root).filter((entry) => entry.endsWith('.ad'))).toEqual([
    'flow.ad',
    'flow.healed.ad',
  ]);
  const parsed = parseReplayScriptDetailed(healedScript);
  // Exactly the repair run's own execution path: open, the corrective press,
  // the surviving click, and the agent's own close — never the source
  // plan's original (skipped) close, never a bare @ref.
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'press', 'click', 'close']);
  const bareRefs = parsed.actions.flatMap((a) => a.positionals.filter((p) => p.startsWith('@')));
  expect(bareRefs).toEqual([]);

  // ============================================================
  // Part 2 — a diverged-and-abandoned repair leaves NO partial file.
  // ============================================================
  const abandoned = setup('agent-device-repair-transaction-abandoned-');
  const abandonedFilePath = writeReplayFile(abandoned.root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'close',
  ]);
  const abandonedInvoke = makeRecordingReplayInvoke({
    sessionStore: abandoned.sessionStore,
    sessionName: abandoned.sessionName,
  });

  const abandonedLeg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [abandonedFilePath], flags: { saveScript: true } }),
    sessionName: abandoned.sessionName,
    logPath: abandoned.logPath,
    sessionStore: abandoned.sessionStore,
    invoke: abandonedInvoke,
  });
  expect(abandonedLeg1.ok).toBe(false);

  // The agent walks away: a plain `close` (no --save-script) reaches the
  // still repair-armed session — Fix 1/2's "abort/discard", not a commit.
  const abandonedCloseResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: abandoned.sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName: abandoned.sessionName,
    logPath: abandoned.logPath,
    sessionStore: abandoned.sessionStore,
    leaseRegistry: abandoned.leaseRegistry,
  });
  expect(abandonedCloseResponse.ok).toBe(true);

  const abandonedHealedPath = path.join(abandoned.root, 'flow.healed.ad');
  expect(fs.existsSync(abandonedHealedPath)).toBe(false);
  // No stray temp artifact either.
  expect(
    fs.existsSync(path.dirname(abandonedHealedPath))
      ? fs.readdirSync(path.dirname(abandonedHealedPath))
      : [],
  ).toEqual(['flow.ad']);
});

test('C5a: an incomplete repair reaped by idle-reap leaves a tombstone (no healed file); a fresh replay --save-script clears it', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-reap-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'close',
  ]);
  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName });

  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  const session = sessionStore.get(sessionName)!;
  expect(session.saveScriptComplete).toBeFalsy();
  expect(session.repairSourcePath).toBe(filePath);

  // Idle-reap tears the still-incomplete repair session down: the writer commits
  // nothing (not complete) and a tombstone is left behind (the exact teardown
  // step daemon-runtime.ts's teardownDaemonSession runs).
  sessionStore.finalizeRepairTeardown(session);
  sessionStore.delete(sessionName);
  expect(fs.existsSync(path.join(root, 'flow.healed.ad'))).toBe(false);

  const tombstone = sessionStore.readRepairTombstone(sessionName);
  expect(tombstone).toBeDefined();
  expect(tombstone?.sourcePath).toBe(filePath);

  // A fresh `replay --save-script` on the same key clears the tombstone.
  await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke: makeRecordingReplayInvoke({ sessionStore, sessionName }),
  });
  expect(sessionStore.readRepairTombstone(sessionName)).toBeUndefined();
});

test('C5a/BLOCKER 3: teardown of a COMPLETE repair auto-commits a self-contained, fresh-replayable healed file (recording the skipped terminal close) and writes NO tombstone', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-autocommit-',
  );
  // A clean (non-diverging) repair-armed replay completes the plan. The
  // source plan's OWN terminal `close` is the exact thing Fix 3 skips while
  // armed — proving BLOCKER 3 requires a source that actually has one.
  const filePath = writeReplayFile(root, ['open "Demo" --relaunch', 'click id="save-v2"', 'close']);
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('save-v2', 'Save V2') : undefined),
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
  expect(session.saveScriptComplete).toBe(true);
  // Fix 3: the source plan's terminal `close` never dispatched or recorded —
  // this is exactly the skip BLOCKER 3 must still account for at teardown.
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'click']);

  // Teardown (e.g. the client tearing down the ephemeral daemon after a clean
  // repair) auto-commits the completed transaction and leaves no tombstone.
  sessionStore.finalizeRepairTeardown(session);
  expect(fs.existsSync(path.join(root, 'flow.healed.ad'))).toBe(true);
  const healedScript = fs.readFileSync(path.join(root, 'flow.healed.ad'), 'utf8');
  expect(healedScript).toContain(HEAL_COMPLETE_SENTINEL);
  expect(sessionStore.readRepairTombstone(sessionName)).toBeUndefined();

  // BLOCKER 3: the ADR requires the committed artifact to be SELF-CONTAINED
  // and fresh-replayable — not merely "a file with the sentinel exists".
  // Parse it and assert it ends with its own terminal `close`, exactly like
  // an explicit `close --save-script` commit does, never a script a fresh
  // replay would run off the end of.
  const parsed = parseReplayScriptDetailed(healedScript);
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'click', 'close']);
  expect(parsed.actions[2]?.positionals).toEqual([]);
  const bareRefs = parsed.actions.flatMap((a) => a.positionals.filter((p) => p.startsWith('@')));
  expect(bareRefs).toEqual([]);
});

test('BLOCKER 1: a --from continuation on a reaped session returns SESSION_NOT_FOUND (translated to REPAIR_SESSION_EXPIRED), not a REPLAY_DIVERGENCE', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-from-reaped-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName });

  // Leg 1 arms + diverges (save renamed to save-v2 in the mock tree).
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const leg1Divergence = leg1.error.details?.divergence as { resume: { planDigest: string } };
  const digest = leg1Divergence.resume.planDigest;

  // Idle-reap tears the incomplete repair down, leaving a tombstone.
  sessionStore.finalizeRepairTeardown(sessionStore.get(sessionName)!);
  sessionStore.delete(sessionName);
  expect(sessionStore.readRepairTombstone(sessionName)).toBeDefined();

  // A `--from` continuation targeting the (now reaped) session must surface
  // SESSION_NOT_FOUND — NOT a REPLAY_DIVERGENCE wrapping the first step's
  // failure — so the router translates it to REPAIR_SESSION_EXPIRED.
  const resumed = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayFrom: 3, replayPlanDigest: digest } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(resumed.ok).toBe(false);
  if (resumed.ok) return;
  expect(resumed.error.code).toBe('SESSION_NOT_FOUND');
  expect(resumed.error.code).not.toBe('REPLAY_DIVERGENCE');
});

/** A COMPLETE, committable repair-armed session at the default healed sibling path. */
function makeCompleteRepairSession(sessionStore: SessionStore, sessionName: string, root: string) {
  const session = makeIosSession(sessionName, { appBundleId: 'com.example.app' });
  session.recordSession = true;
  session.saveScriptBoundary = 0;
  session.saveScriptComplete = true;
  session.saveScriptPath = path.join(root, 'flow.healed.ad');
  session.saveScriptDefaultedHealedPath = true;
  session.actions = [
    { ts: 1, command: 'open', positionals: ['Demo'], flags: {} },
    {
      ts: 2,
      command: 'press',
      positionals: ['@e7'],
      flags: {},
      result: { selectorChain: ['id="save-v2"'] },
      targetEvidence: freshEvidence('save-v2', 'Save V2'),
    },
  ];
  sessionStore.set(sessionName, session);
  return session;
}

test('BLOCKER 2b/2c: a close whose commit FAILS (no-clobber) keeps the session for retry and surfaces a distinct error', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-commit-fail-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  // A prior COMPLETE (sentinel-marked) healed artifact already sits at the
  // default path — the commit must refuse to clobber it.
  fs.writeFileSync(
    path.join(root, 'flow.healed.ad'),
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(path.join(root, 'flow.healed.ad'), 'utf8');

  const closeResponse = await handleCloseCommand({
    req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // BLOCKER 2b: the commit failed, so the session is NOT torn down — it stays
  // addressable so the agent can retry (e.g. `close --save-script=<other>`).
  expect(closeResponse.ok).toBe(false);
  expect(sessionStore.get(sessionName)).toBeDefined();
  // BLOCKER 2c: a no-clobber refusal is a distinct, surfaced error (not a silent
  // success, not a swallowed skip), distinguishable from a filesystem failure.
  if (!closeResponse.ok) {
    expect(closeResponse.error.message).toMatch(/already exists/);
    // BLOCKER 3 (original): the session was kept specifically so the agent
    // can retry — `retriable` must say so, never contradict that recovery
    // guidance. BLOCKER 2 (second follow-up): at the TOP level of the error —
    // the location the router/client actually read — never buried under
    // `details`.
    expect(closeResponse.error.retriable).toBe(true);
    expect(closeResponse.error.details?.retriable).toBeUndefined();
  }
  // The prior complete artifact is untouched.
  expect(fs.readFileSync(path.join(root, 'flow.healed.ad'), 'utf8')).toBe(before);
  // The rolled-back finalize `close` did not linger, so a retry does not
  // accumulate a duplicate `close` in the healed slice.
  expect(sessionStore.get(sessionName)!.actions.filter((a) => a.command === 'close')).toHaveLength(
    0,
  );

  // Retry with an explicit path commits cleanly — exactly ONE terminal close.
  const retryPath = path.join(root, 'flow.promoted.ad');
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: retryPath },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(retry.ok).toBe(true);
  if (retry.ok) expect(retry.data?.savedScript).toBe(retryPath);
  const promoted = parseReplayScriptDetailed(fs.readFileSync(retryPath, 'utf8'));
  expect(promoted.actions.filter((a) => a.command === 'close')).toHaveLength(1);
});

// --- #1258: `--force`/`--overwrite` on `--save-script`. ---

test('#1258: close --save-script --force overwrites an existing COMPLETE healed .ad instead of refusing', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-force-overwrite-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  // A prior COMPLETE (sentinel-marked) healed artifact already sits at the
  // default path — `--force` must overwrite it instead of refusing.
  fs.writeFileSync(
    path.join(root, 'flow.healed.ad'),
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { force: true },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  expect(closeResponse.ok).toBe(true);
  expect(sessionStore.get(sessionName)).toBeUndefined();
  const healedPath = path.join(root, 'flow.healed.ad');
  if (closeResponse.ok) expect(closeResponse.data?.savedScript).toBe(healedPath);
  const script = fs.readFileSync(healedPath, 'utf8');
  expect(script).toContain(HEAL_COMPLETE_SENTINEL);
  const parsed = parseReplayScriptDetailed(script);
  // The new repair's own actions replaced the stale prior artifact — the old
  // content is gone, never merged/appended.
  expect(parsed.actions.some((a) => a.positionals[0] === 'id="old"')).toBe(false);
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'press', 'close']);
});

test('#1258 arm-time preflight: an existing --save-script target rejects BEFORE any step runs', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-arm-preflight-',
  );
  const filePath = writeReplayFile(root, ['open "Demo" --relaunch', 'close']);
  // The default healed sibling already exists — a prior repair, or an
  // unrelated stale file sitting at that path.
  fs.writeFileSync(path.join(root, 'flow.healed.ad'), 'context platform=ios device="x"\n');

  const spy: DaemonRequest[] = [];
  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName, spy });

  const result = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('COMMAND_FAILED');
    expect(result.error.message).toMatch(/already exists/);
  }
  // Not a single step dispatched — the preflight fired BEFORE the loop, not
  // merely at the end (publish time). Even `open` never ran.
  expect(spy).toHaveLength(0);
  // The session was never armed (no boundary stamped) either — the whole
  // repair-arm side effect is skipped, not just the dispatch.
  expect(sessionStore.get(sessionName)?.saveScriptBoundary).toBeUndefined();
});

test('#1258: --force skips the arm-time preflight and the replay proceeds despite the existing target', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-arm-preflight-force-',
  );
  const filePath = writeReplayFile(root, ['open "Demo" --relaunch', 'close']);
  fs.writeFileSync(path.join(root, 'flow.healed.ad'), 'context platform=ios device="x"\n');

  const spy: DaemonRequest[] = [];
  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName, spy });

  const result = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true, force: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });

  expect(result.ok).toBe(true);
  // `open` dispatched — the preflight did not block it. The terminal `close`
  // is skipped while repair-armed (existing, unrelated behavior), so `open`
  // is the only step this minimal script actually dispatches.
  expect(spy.map((r) => r.command)).toEqual(['open']);
  // `force` is persisted on the session from arm time, so a LATER commit
  // (e.g. a bare `close`, or teardown) still honors the overwrite.
  expect(sessionStore.get(sessionName)?.saveScriptForce).toBe(true);
});

test('#1258 preflight honors PERSISTED force: a --from continuation without --force is NOT rejected on an existing target a prior --force leg authorized', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-preflight-persisted-force-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  // The healed target already exists — the preflight WOULD reject a
  // continuation that only saw the (absent, this leg) LIVE force flag.
  fs.writeFileSync(path.join(root, 'flow.healed.ad'), 'context platform=ios device="x"\n');
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });

  // Leg 1: `replay --save-script --force` — the LIVE force passes the preflight
  // (target exists), arms the session, PERSISTS saveScriptForce, then diverges
  // (nothing published, so the pre-existing target survives).
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true, force: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  expect(leg1.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = leg1.error.details?.divergence as { resume: { planDigest: string } };
  expect(sessionStore.get(sessionName)?.saveScriptForce).toBe(true);

  // The agent's corrective press (blessed @ref), recorded live.
  const session = sessionStore.get(sessionName)!;
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });

  // Leg 2: `replay --from N --save-script` WITHOUT --force — the target still
  // exists. The persisted saveScriptForce must make the arm-time preflight use
  // the SAME effective decision publication uses, so this is NOT rejected.
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  // Not rejected by the arm-time preflight (no "already exists"): the
  // transaction reached completion instead.
  expect(leg2.ok).toBe(true);
  expect(sessionStore.get(sessionName)?.saveScriptComplete).toBe(true);
  // A bare-boolean continuation never retargets, so force stays persisted.
  expect(sessionStore.get(sessionName)?.saveScriptForce).toBe(true);
});

test('#1258 preflight is per-target: a --from continuation RETARGETING to an existing <b> WITHOUT live force is refused BEFORE dispatch, preserves the prior COMPLETE transaction, and a later close still commits the ORIGINAL <a>', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-preflight-retarget-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const targetA = path.join(root, 'a.ad');
  const targetB = path.join(root, 'b.ad');
  // <b> already exists (nobody opted to overwrite it); <a> does not, so leg 1
  // arms/forces <a> cleanly.
  fs.writeFileSync(targetB, 'context platform=ios device="x"\nclick id="unrelated"\n');
  const beforeB = fs.readFileSync(targetB, 'utf8');
  const spy: DaemonRequest[] = [];
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    spy,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });

  // Leg 1: `--save-script=<a> --force` — arms + PERSISTS force for <a>, then
  // diverges (nothing published).
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: targetA, force: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as { resume: { planDigest: string } };
  const session = sessionStore.get(sessionName)!;
  expect(session.saveScriptPath).toBe(targetA);
  expect(session.saveScriptForce).toBe(true);
  // The agent's corrective press.
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });
  // The transaction for <a> has now reached COMPLETE (a resume leg ran to the
  // end) — set directly here, mirroring `makeCompleteRepairSession`'s
  // convention, to isolate THIS test's concern: a later retarget REJECTION must
  // not corrupt this flag (BLOCKER 2 — the C2 `saveScriptComplete = false`
  // reset must run AFTER the preflight's early-return, never before it).
  session.saveScriptComplete = true;
  const dispatchesBeforeLeg2 = spy.length;

  // Leg 2: `--from N --save-script=<b>` (explicit RETARGET, NO live force) — <b>
  // exists. The persisted force was granted for <a>, and
  // `applySaveScriptRetarget` WOULD clear it for <b>; the preflight must MATCH
  // that per-target contract and REFUSE here, before any step dispatches,
  // instead of executing the leg and only refusing at publish time.
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: targetB, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(false);
  if (!leg2.ok) {
    expect(leg2.error.code).toBe('COMMAND_FAILED');
    expect(leg2.error.message).toMatch(/already exists/);
  }
  // Not a single step of leg 2 dispatched — refused BEFORE the loop.
  expect(spy.length).toBe(dispatchesBeforeLeg2);
  // READ-ONLY: the rejected request left the session target untouched — still
  // armed/forced for <a>, never retargeted to <b>.
  expect(sessionStore.get(sessionName)?.saveScriptPath).toBe(targetA);
  expect(sessionStore.get(sessionName)?.saveScriptForce).toBe(true);
  // BLOCKER 2 (a): the prior COMPLETE transaction SURVIVES the rejection — the
  // C2 completion reset never ran, because the preflight returned first.
  expect(sessionStore.get(sessionName)?.saveScriptComplete).toBe(true);
  // <b> is byte-for-byte untouched.
  expect(fs.readFileSync(targetB, 'utf8')).toBe(beforeB);

  // BLOCKER 2 (b): a later bare `close` still COMMITS the ORIGINAL target <a>
  // (never the rejected <b>) — proof the rejected retarget corrupted neither
  // the completion flag nor the target path.
  const closeResponse = await handleCloseCommand({
    req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(closeResponse.ok).toBe(true);
  if (closeResponse.ok) expect(closeResponse.data?.savedScript).toBe(targetA);
  expect(fs.existsSync(targetA)).toBe(true);
  const committed = parseReplayScriptDetailed(fs.readFileSync(targetA, 'utf8'));
  expect(committed.actions.map((a) => a.command)).toEqual(['open', 'press', 'close']);
  // <b> stayed untouched through the commit too.
  expect(fs.readFileSync(targetB, 'utf8')).toBe(beforeB);
});

test('#1258 force is per-target: re-arming --save-script=<b> WITHOUT --force drops force persisted for <a>, so <b> is NOT overwritten', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-retarget-clears-force-',
  );
  // Armed and forced for target <a> (flow.healed.ad).
  const session = makeCompleteRepairSession(sessionStore, sessionName, root);
  session.saveScriptForce = true;
  // A DIFFERENT, unrelated file already sits at the retarget destination <b>
  // (flow.promoted.ad) — nobody opted to overwrite THIS one.
  const promotedPath = path.join(root, 'flow.promoted.ad');
  fs.writeFileSync(
    promotedPath,
    `context platform=ios device="x"\nclick id="unrelated"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(promotedPath, 'utf8');

  // `close --save-script=<b>` (NO --force): retargeting from <a> to <b>
  // without a live opt-in drops the force that was granted for <a>.
  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: promotedPath },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // Refused — the retarget cleared the sticky force, so <b> is protected by the
  // default no-clobber exactly like a fresh target would be.
  expect(closeResponse.ok).toBe(false);
  if (!closeResponse.ok) expect(closeResponse.error.message).toMatch(/already exists/);
  // <b> is untouched, and the session is kept for retry.
  expect(fs.readFileSync(promotedPath, 'utf8')).toBe(before);
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(sessionStore.get(sessionName)?.saveScriptForce).toBeUndefined();
});

test('#1258 force per-target, contrast: re-arming --save-script=<b> WITH --force DOES overwrite <b>', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-retarget-force-overwrites-',
  );
  const session = makeCompleteRepairSession(sessionStore, sessionName, root);
  session.saveScriptForce = true;
  const promotedPath = path.join(root, 'flow.promoted.ad');
  fs.writeFileSync(
    promotedPath,
    `context platform=ios device="x"\nclick id="unrelated"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  // `close --save-script=<b> --force`: the live opt-in re-grants force for the
  // new target, overwriting it.
  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: promotedPath, force: true },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  expect(closeResponse.ok).toBe(true);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(promotedPath, 'utf8'));
  expect(parsed.actions.some((a) => a.positionals[0] === 'id="unrelated"')).toBe(false);
});

test('BLOCKER 2 (new): a repair close whose PLATFORM close fails never commits a healed .ad claiming a successful close', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-platform-close-fail-',
  );
  const session = makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');

  // A targeted close (an explicit positional app target) is what makes
  // `dispatchTargetedPlatformClose` actually dispatch instead of no-op.
  const platformCloseError = new AppError('DEVICE_UNAVAILABLE', 'platform close failed', {
    reason: 'device_disconnected',
    hint: 'Reconnect the device and retry close.',
    // BLOCKER 2 (second follow-up): the underlying platform error's own
    // diagnosticId/logPath must survive normalization, never be flattened away.
    diagnosticId: 'diag-platform-close-1',
    logPath: '/tmp/platform-close-1.log',
  });
  mockDispatchCommand.mockRejectedValueOnce(platformCloseError);

  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // The prior implementation committed (recorded a successful `close` +
  // published the healed .ad) BEFORE the platform close ran at all, so a
  // failing platform close still left a COMMITTED artifact on disk claiming
  // success, contradicting the failed-close lifecycle contract. Fixed: the
  // platform close runs first, so a failure here means NOTHING was committed.
  expect(fs.existsSync(healedPath)).toBe(false);
  expect(closeResponse.ok).toBe(false);
  if (!closeResponse.ok) {
    expect(closeResponse.error.code).toBe('DEVICE_UNAVAILABLE');
    // BLOCKER 3 (original): the session was kept for retry — `retriable`
    // must agree. BLOCKER 2 (second follow-up): at the TOP level, and the
    // underlying platform error's diagnosticId/logPath/details are preserved
    // rather than discarded.
    expect(closeResponse.error.retriable).toBe(true);
    expect(closeResponse.error.details?.retriable).toBeUndefined();
    expect(closeResponse.error.diagnosticId).toBe('diag-platform-close-1');
    expect(closeResponse.error.logPath).toBe('/tmp/platform-close-1.log');
    expect(closeResponse.error.details?.reason).toBe('device_disconnected');
  }
  // BLOCKER 2b-style contract: the session stays addressable, untouched, so
  // the agent can fix the cause (e.g. reconnect the device) and retry.
  expect(sessionStore.get(sessionName)).toBe(session);
  expect(session.actions.some((a) => a.command === 'close')).toBe(false);

  // Retry once the platform close succeeds: commits cleanly.
  mockDispatchCommand.mockResolvedValueOnce({});
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(retry.ok).toBe(true);
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  expect(healedScript).toContain(HEAL_COMPLETE_SENTINEL);
  expect(
    parseReplayScriptDetailed(healedScript).actions.filter((a) => a.command === 'close'),
  ).toHaveLength(1);
});

test('BLOCKER 3 (second follow-up): a retry after a SUCCESSFUL platform close but a FAILED commit never re-dispatches the platform close', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-close-idempotent-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');
  // A prior COMPLETE (sentinel-marked) healed artifact already sits at the
  // default path — the commit must refuse to clobber it, giving a
  // deterministic commit FAILURE after a platform close that genuinely
  // succeeds (mockDispatchCommand's `beforeEach` default resolves). A
  // targeted close (an explicit positional app target) is what makes
  // `dispatchTargetedPlatformClose` actually dispatch instead of no-op.
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(healedPath, 'utf8');

  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // The platform close genuinely ran and succeeded; the SUBSEQUENT commit
  // failed (no-clobber) — the session is retained for retry.
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
  expect(closeResponse.ok).toBe(false);
  if (!closeResponse.ok) expect(closeResponse.error.message).toMatch(/already exists/);
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(before);
  expect(sessionStore.get(sessionName)!.repairPlatformCloseSucceeded).toBe(true);

  // Retry with an explicit path: the ALREADY-SUCCEEDED platform close must
  // NEVER be dispatched again — a non-idempotent backend could fail (or
  // wedge recovery entirely) on a second close of an already-closed target.
  const retryPath = path.join(root, 'flow.promoted.ad');
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: { saveScript: retryPath },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // Still exactly ONE dispatch total — the retry consumed the recorded
  // success and went straight to the commit.
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
  expect(retry.ok).toBe(true);
  expect(fs.existsSync(retryPath)).toBe(true);
  const promoted = fs.readFileSync(retryPath, 'utf8');
  expect(promoted).toContain(HEAL_COMPLETE_SENTINEL);
});

test('BLOCKER 3: a competing second writer never overwrites a COMPLETE artifact and gets a clear no-clobber error', async () => {
  const { root, sessionStore, sessionName } = setup('agent-device-repair-transaction-competing-');
  const healedPath = path.join(root, 'flow.healed.ad');

  // Writer 1 commits a complete artifact at the default healed path.
  const first = makeCompleteRepairSession(sessionStore, `${sessionName}-1`, root);
  const r1 = sessionStore.writeSessionLog(first);
  expect(r1.written).toBe(true);
  const committed = fs.readFileSync(healedPath, 'utf8');
  expect(committed).toContain(HEAL_COMPLETE_SENTINEL);

  // Writer 2 (a second repair on the same source → same default path) attempts
  // to publish over it. The atomic create-exclusive publish must FAIL rather
  // than overwrite the complete artifact.
  const second = makeCompleteRepairSession(sessionStore, `${sessionName}-2`, root);
  second.actions[1] = {
    ts: 2,
    command: 'press',
    positionals: ['@e9'],
    flags: {},
    result: { selectorChain: ['id="different"'] },
    targetEvidence: freshEvidence('different', 'Different'),
  };
  const r2 = sessionStore.writeSessionLog(second);
  expect(r2.written).toBe(false);
  expect(r2.written === false && r2.error?.message).toMatch(/already exists/);
  // The first writer's complete artifact is byte-for-byte intact.
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(committed);
});

// --- ADR 0012 decision 6 (BLOCKER 3, third follow-up): `repairPlatformCloseSucceeded`
// was session-wide, not bound to WHICH close request actually succeeded. An
// untargeted close performs NO platform operation (`shouldDispatchPlatformClose`
// is false with no positional target), yet the prior implementation still set
// the marker as though a real close succeeded; a retry with a DIFFERENT
// identity (a target added, or a different target) then wrongly skipped the
// platform close entirely, committing as though it had run. ---

test('BLOCKER 3 (third follow-up): an untargeted close that performed NO platform operation never lets a targeted retry skip the platform close', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-close-identity-untargeted-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');
  // A prior COMPLETE artifact already sits at the default path so the commit
  // deterministically fails and the session is retained for retry.
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  // First attempt: UNTARGETED close — `shouldDispatchPlatformClose` is false
  // (no positional target, not `web`), so the platform close never dispatches
  // at all; the commit then fails (no-clobber).
  const first = await handleCloseCommand({
    req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(first.ok).toBe(false);
  expect(mockDispatchCommand).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBeDefined();

  // Retry WITH a target: the prior session-wide `repairPlatformCloseSucceeded`
  // flag (set true even though nothing dispatched for the untargeted attempt)
  // would wrongly skip the platform close here. It must actually run.
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: { saveScript: path.join(root, 'flow.promoted.ad') },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
  expect(mockDispatchCommand.mock.calls[0]?.[2]).toEqual(['com.example.app']);
  expect(retry.ok).toBe(true);
});

test('BLOCKER 3 (third follow-up): a retry targeting a DIFFERENT app than the succeeded close never skips the platform close for the new target', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-close-identity-changed-target-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  // First attempt targets app-a; the platform close succeeds, the commit fails.
  const first = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app-a'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(first.ok).toBe(false);
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
  expect(sessionStore.get(sessionName)!.repairPlatformCloseSucceeded).toBe(true);

  // Retry targets a DIFFERENT app (app-b) — a genuinely different platform
  // operation. The prior session-wide marker would wrongly treat app-b as
  // already closed just because SOME close succeeded. It must dispatch again,
  // against app-b specifically.
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app-b'],
      flags: { saveScript: path.join(root, 'flow.promoted.ad') },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(mockDispatchCommand).toHaveBeenCalledTimes(2);
  expect(mockDispatchCommand.mock.calls[1]?.[2]).toEqual(['com.example.app-b']);
  expect(retry.ok).toBe(true);
});
