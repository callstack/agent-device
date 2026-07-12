/**
 * ADR 0012 decision 6 acceptance test: a healed sibling `.ad` produced by the
 * repair loop must replay end-to-end in a FRESH session, with every selector
 * step annotated and no bare `@ref` — and the healed `open` line must be
 * self-contained (R5): it carries the same `--relaunch`/platform/metro flags
 * the original recorded, so the fresh replay needs no hand-fixing.
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
import { parseReplayScriptDetailed } from '../../../replay/script.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';
import { freshEvidence, makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  // The "current" app state throughout this test: "save" was renamed to
  // "save-v2" (why the recorded step 2 diverges) and "confirm" is present.
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
      {
        index: 1,
        depth: 0,
        type: 'Button',
        identifier: 'confirm',
        label: 'Confirm',
        rect: { x: 60, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
});

const SAVE_ANNOTATION =
  '# agent-device:target-v1 {"id":"save","role":"button","label":"Save","ancestry":[],"sibling":0,"viewportOrder":0,"verification":"verified"}';

test('a healed script survives repair + fresh-session replay: self-contained open, every selector step annotated, no bare @ref', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-accept-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch --platform ios --metro-port 8081',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
  ]);

  // "click id=save" diverges via target verification (selector-miss, save was
  // renamed to save-v2 in the mock tree) BEFORE reaching invoke, so invoke
  // only ever records open + the confirm click (with fresh evidence).
  const repairInvoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });

  // --- Leg 1: open records; "click id=save" diverges (renamed to save-v2). ---
  const leg1 = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: repairInvoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as {
    kind: string;
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.kind).toBe('selector-miss');

  const session = sessionStore.get(sessionName)!;
  expect(session.actions.map((a) => a.command)).toEqual(['open']);

  // --- Agent presses the blessed @ref (record-and-heal): recorded live. ---
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });

  // --- Leg 2: resume past the step the agent just performed. ---
  const leg2 = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: repairInvoke,
  });
  expect(leg2.ok).toBe(true);
  expect(session.actions.map((a) => a.command)).toEqual(['open', 'press', 'click']);

  // --- End the repair: write the healed script (the `close --save-script`
  // path reuses exactly this writer). ---
  sessionStore.writeSessionLog(session);
  const healedPath = path.join(root, 'flow.healed.ad');
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');

  assertHealedScriptStructure(healedScript);

  // --- Replay the healed script end-to-end in a completely FRESH session
  // (separate SessionStore, separate state dir — never reuses the repair
  // session). ---
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-fresh-'));
  const freshSessionStore = new SessionStore(path.join(freshRoot, 'sessions'));
  const freshSessionName = 'fresh';
  const invokedFresh: DaemonRequest[] = [];
  const freshReplay = await runReplayScriptFile({
    req: baseReq({ session: freshSessionName, positionals: [healedPath] }),
    sessionName: freshSessionName,
    logPath: path.join(freshRoot, 'daemon.log'),
    sessionStore: freshSessionStore,
    invoke: makeRecordingReplayInvoke({
      sessionStore: freshSessionStore,
      sessionName: freshSessionName,
      openReplacesSession: true,
      spy: invokedFresh,
    }),
  });

  assertFreshReplayReached(freshReplay, invokedFresh);
});

/**
 * The healed `.ad` parses back to exactly the repair run's execution path:
 * self-contained `open` (relaunch/platform/metro travel with it), every
 * selector step annotated with fresh evidence, and no bare `@ref`.
 */
function assertHealedScriptStructure(healedScript: string): void {
  expect(healedScript).not.toMatch(/@e\d/);
  const annotationCount = (healedScript.match(/# agent-device:target-v1/g) ?? []).length;
  expect(annotationCount).toBe(2); // the corrective press + the confirm click
  const parsed = parseReplayScriptDetailed(healedScript);
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'press', 'click']);
  const [open, press, click] = parsed.actions;
  expect(open?.positionals).toEqual(['Demo']);
  expect(open?.flags?.relaunch).toBe(true);
  expect(open?.runtime).toEqual({ platform: 'ios', metroPort: 8081 });
  expect(press?.positionals).toEqual(['id="save-v2"']);
  expect(press?.targetEvidence?.id).toBe('save-v2');
  expect(click?.positionals).toEqual(['id="confirm"']);
  expect(click?.targetEvidence?.id).toBe('confirm');
  const bareRefs = parsed.actions.flatMap((a) => a.positionals.filter((p) => p.startsWith('@')));
  expect(bareRefs).toEqual([]);
}

/** The fresh-session replay dispatched every step with the healed open's flags intact. */
function assertFreshReplayReached(
  freshReplay: Awaited<ReturnType<typeof runReplayScriptFile>>,
  invokedFresh: DaemonRequest[],
): void {
  expect(freshReplay.ok).toBe(true);
  if (!freshReplay.ok) return;
  expect((freshReplay.data as { replayed: number }).replayed).toBe(3);
  expect(invokedFresh.map((r) => r.command)).toEqual(['open', 'press', 'click']);
  const openReq = invokedFresh[0];
  expect(openReq?.positionals).toEqual(['Demo']);
  expect(openReq?.flags?.relaunch).toBe(true);
  expect(openReq?.runtime).toEqual({ platform: 'ios', metroPort: 8081 });
}
