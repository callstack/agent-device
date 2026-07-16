/**
 * #1271 stage 2 (ADR 0012 amendment): repair-segment default exclusion of
 * observation-only commands (`snapshot`/`get`/`is`/a read-only `find`), the
 * `--record` opt-in for the corrective-read case, and the fail-loud empty-
 * segment guard. Exercised end to end at the same layer the ADR 0012 decision
 * 6 lifecycle tests use — `runReplayScriptFile` + `handleCloseCommand` sharing
 * a live `SessionStore`, exactly like an agent's separate CLI invocations
 * against the same daemon session.
 *
 * Required regression coverage (per the maintainer's triage on #1271):
 * - a diagnostic read inside a repair segment is omitted from the heal;
 * - a corrective action remains — both a mutating press (never
 *   observation-only) and a `--record`ed read (the diverged-step-was-a-`get`
 *   case);
 * - the resulting healed script replays cleanly;
 * - the empty-segment guard refuses with the actionable `--record` error;
 * - non-repair authoring recording (a fresh `open --save-script` session) is
 *   completely unchanged.
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
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { parseReplayScriptDetailed } from '../../../replay/script.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import { freshEvidence, makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  // The "current" app state: "save" was renamed to "save-v2" (why the click
  // on `id="save"` diverges as a `selector-miss`) — nested under a "Toolbar"
  // container so the recorded ancestry (below) has a real, present container
  // to find (`repairHint`'s R3 container-presence test requires a non-empty
  // ancestry/scrollRegion signal, else it fails safe to `manual`). "confirm"
  // is also present so the surviving `click id="confirm"` step (freshly
  // annotated during the repair) and the healed script's fresh re-replay both
  // verify cleanly.
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'View',
        label: 'Toolbar',
        rect: { x: 0, y: 0, width: 200, height: 400 },
      },
      {
        index: 1,
        depth: 1,
        type: 'Button',
        identifier: 'save-v2',
        label: 'Save V2',
        parentIndex: 0,
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
      {
        index: 2,
        depth: 1,
        type: 'Button',
        identifier: 'confirm',
        label: 'Confirm',
        parentIndex: 0,
        rect: { x: 10, y: 40, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
});

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[{"role":"view","label":"Toolbar"}],"sibling":0,"viewportOrder":0,"verification":"verified"}';

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

/** Drives leg 1 of the repair: arm + diverge on the renamed `id="save"`. */
async function armAndDiverge(params: ReturnType<typeof setup>, filePath: string) {
  const { sessionStore, sessionName, logPath } = params;
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) throw new Error('expected a divergence');
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    repairHint: string;
    resume: { allowed: boolean; from: number; planDigest: string; repairSessionHeld?: boolean };
  };
  expect(divergence.kind).toBe('selector-miss');
  expect(divergence.repairHint).toBe('record-and-heal');
  expect(divergence.resume.allowed).toBe(true);
  expect(divergence.resume.from).toBe(3);
  expect(divergence.resume.repairSessionHeld).toBe(true);
  return { invoke, divergence };
}

test('diagnostic get/is reads mid-repair are excluded from the healed script by default; the corrective press remains', async () => {
  const ctx = setup('agent-device-repair-record-exclusion-press-');
  const filePath = writeReplayFile(ctx.root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const { invoke, divergence } = await armAndDiverge(ctx, filePath);
  const session = ctx.sessionStore.get(ctx.sessionName)!;

  // --- The agent explores mid-repair: a couple of diagnostic reads to locate
  // the renamed control. Both are observation-only and the session is
  // repair-armed, so per the default exclusion neither is appended. ---
  ctx.sessionStore.recordAction(session, {
    command: 'get',
    positionals: ['attrs', '@e5'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    interactiveObservation: true,
  });
  ctx.sessionStore.recordAction(session, {
    command: 'is',
    positionals: ['visible', 'id="save-v2"'],
    flags: {},
    result: {},
    interactiveObservation: true,
  });
  // Excluded: `session.actions` did not grow past the recorded `open`.
  expect(session.actions.map((a) => a.command)).toEqual(['open']);

  // --- The agent performs the corrective press (blessed @ref), recorded live —
  // a mutating action is never observation-only, so it is unaffected. ---
  ctx.sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press']);

  // --- `replay --from N+1` resumes to completion (terminal close skipped). ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName: ctx.sessionName,
    logPath: ctx.logPath,
    sessionStore: ctx.sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press', 'click']);
  expect(session.saveScriptComplete).toBe(true);

  // --- Finalize: `close --save-script` commits the healed `.ad`. ---
  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: ctx.sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: true },
    },
    sessionName: ctx.sessionName,
    logPath: ctx.logPath,
    sessionStore: ctx.sessionStore,
    leaseRegistry: ctx.leaseRegistry,
  });
  expect(closeResponse.ok).toBe(true);

  const healedPath = path.join(ctx.root, 'flow.healed.ad');
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  expect(healedScript).not.toContain('get attrs');
  expect(healedScript).not.toContain('is visible');
  const parsed = parseReplayScriptDetailed(healedScript);
  // Exactly the repair run's own execution path: open, the corrective press,
  // the surviving click, and the agent's own close — the diagnostic get/is
  // never appear, and neither does the source plan's original (skipped) close.
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'press', 'click', 'close']);

  // --- The healed script replays cleanly in a FRESH session. ---
  const fresh = setup('agent-device-repair-record-exclusion-press-fresh-');
  const freshInvoke = makeRecordingReplayInvoke({
    sessionStore: fresh.sessionStore,
    sessionName: fresh.sessionName,
  });
  const freshRun = await runReplayScriptFile({
    req: baseReq({ positionals: [healedPath] }),
    sessionName: fresh.sessionName,
    logPath: fresh.logPath,
    sessionStore: fresh.sessionStore,
    invoke: freshInvoke,
  });
  expect(freshRun.ok).toBe(true);
});

test("a --record'ed diagnostic read lands in the healed script (the diverged-step-was-a-get case)", async () => {
  const ctx = setup('agent-device-repair-record-exclusion-record-');
  const filePath = writeReplayFile(ctx.root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const { invoke, divergence } = await armAndDiverge(ctx, filePath);
  const session = ctx.sessionStore.get(ctx.sessionName)!;

  // --- The agent's correction for the diverged step IS itself a read (the
  // wave-3 E3 shape): `get attrs` on the renamed control, explicitly forced
  // into the heal with `--record` since it would otherwise be excluded. ---
  ctx.sessionStore.recordAction(session, {
    command: 'get',
    positionals: ['attrs', '@e7'],
    flags: { record: true },
    result: { selectorChain: ['id="save-v2"'] },
    interactiveObservation: true,
  });
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'get']);

  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName: ctx.sessionName,
    logPath: ctx.logPath,
    sessionStore: ctx.sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(true);
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'get', 'click']);

  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: ctx.sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: true },
    },
    sessionName: ctx.sessionName,
    logPath: ctx.logPath,
    sessionStore: ctx.sessionStore,
    leaseRegistry: ctx.leaseRegistry,
  });
  expect(closeResponse.ok).toBe(true);

  const healedPath = path.join(ctx.root, 'flow.healed.ad');
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  const parsed = parseReplayScriptDetailed(healedScript);
  // The --record'ed corrective read DOES land in the heal, resolved to a
  // selector (never a bare @ref).
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'get', 'click', 'close']);
  const getAction = parsed.actions.find((a) => a.command === 'get');
  expect(getAction?.positionals).toEqual(['attrs', 'id="save-v2"']);
  const bareRefs = parsed.actions.flatMap((a) => a.positionals.filter((p) => p.startsWith('@')));
  expect(bareRefs).toEqual([]);

  // --- Replays cleanly in a fresh session too. ---
  const fresh = setup('agent-device-repair-record-exclusion-record-fresh-');
  const freshInvoke = makeRecordingReplayInvoke({
    sessionStore: fresh.sessionStore,
    sessionName: fresh.sessionName,
  });
  const freshRun = await runReplayScriptFile({
    req: baseReq({ positionals: [healedPath] }),
    sessionName: fresh.sessionName,
    logPath: fresh.logPath,
    sessionStore: fresh.sessionStore,
    invoke: freshInvoke,
  });
  expect(freshRun.ok).toBe(true);
});

test('empty-segment guard: a --from resume refuses with an actionable --record hint when only excluded diagnostic reads happened since the divergence', async () => {
  const ctx = setup('agent-device-repair-record-exclusion-empty-segment-');
  const filePath = writeReplayFile(ctx.root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const { invoke, divergence } = await armAndDiverge(ctx, filePath);
  const session = ctx.sessionStore.get(ctx.sessionName)!;

  // --- The agent ONLY inspects — never performs a corrective action. Both
  // reads are excluded from `session.actions`, so nothing was recorded in
  // this repair segment. ---
  ctx.sessionStore.recordAction(session, {
    command: 'get',
    positionals: ['attrs', '@e5'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    interactiveObservation: true,
  });
  ctx.sessionStore.recordAction(session, {
    command: 'find',
    positionals: ['id', 'save-v2', 'exists'],
    flags: {},
    result: { found: true },
    interactiveObservation: true,
  });
  expect(session.actions.map((a) => a.command)).toEqual(['open']);

  const blindResume = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName: ctx.sessionName,
    logPath: ctx.logPath,
    sessionStore: ctx.sessionStore,
    invoke,
  });
  expect(blindResume.ok).toBe(false);
  if (blindResume.ok) return;
  expect(blindResume.error.code).toBe('INVALID_ARGS');
  expect(blindResume.error.message).toMatch(/no corrective action/);
  expect(blindResume.error.message).toMatch(/--record/);
  // Refused before any device action ran — the excluded reads are the only
  // activity since the divergence.
  expect(session.actions.map((a) => a.command)).toEqual(['open']);
});

test('non-repair authoring recording is unchanged: a read in a fresh `open --save-script` session still records with no flag needed', async () => {
  const ctx = setup('agent-device-repair-record-exclusion-authoring-');
  // An ordinary, non-repair recording session: no `saveScriptBoundary` (never
  // armed by a repair `replay --save-script`).
  const session = ctx.sessionStore.get(ctx.sessionName)!;
  session.recordSession = true;
  expect(session.saveScriptBoundary).toBeUndefined();

  ctx.sessionStore.recordAction(session, {
    command: 'get',
    positionals: ['attrs', '@e5'],
    flags: {},
    result: { selectorChain: ['id="save"'] },
    interactiveObservation: true,
  });
  // Recorded normally — no `--record` needed, no repair segment in play.
  expect(session.actions.map((a) => a.command)).toEqual(['get']);
});
