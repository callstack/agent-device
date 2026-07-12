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
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import type { TargetAnnotationV1 } from '../../../replay/target-identity.ts';
import { parseReplayScriptDetailed } from '../../../replay/script.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';

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

  const repairInvoke = async (req: DaemonRequest): Promise<DaemonResponse> => {
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
    if (req.command === 'click' && req.positionals?.[0] === 'id="confirm"') {
      const targetEvidence = session.recordSession
        ? freshEvidence('confirm', 'Confirm')
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

  // No bare @ref anywhere in the healed output.
  expect(healedScript).not.toMatch(/@e\d/);
  // Every selector step is annotated.
  const annotationCount = (healedScript.match(/# agent-device:target-v1/g) ?? []).length;
  expect(annotationCount).toBe(2); // the corrective press + the confirm click
  // The open line is self-contained: relaunch + platform + metro-port travel
  // with it, not just the bare app name — parsed back structurally (the raw
  // text is JSON-quoted by the writer for non-bare selector arguments).
  const healedParsed = parseReplayScriptDetailed(healedScript);
  expect(healedParsed.actions.map((a) => a.command)).toEqual(['open', 'press', 'click']);
  expect(healedParsed.actions[0]?.positionals).toEqual(['Demo']);
  expect(healedParsed.actions[0]?.flags?.relaunch).toBe(true);
  expect(healedParsed.actions[0]?.runtime).toEqual({ platform: 'ios', metroPort: 8081 });
  expect(healedParsed.actions[1]?.positionals).toEqual(['id="save-v2"']);
  expect(healedParsed.actions[1]?.targetEvidence?.id).toBe('save-v2');
  expect(healedParsed.actions[2]?.positionals).toEqual(['id="confirm"']);
  expect(healedParsed.actions[2]?.targetEvidence?.id).toBe('confirm');
  // No positional anywhere is a bare, unresolved @ref.
  expect(healedParsed.actions.every((a) => a.positionals.every((p) => !p.startsWith('@')))).toBe(
    true,
  );

  // --- Replay the healed script end-to-end in a completely FRESH session
  // (separate SessionStore, separate state dir — never reuses the repair
  // session). ---
  const freshRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-repair-fresh-'));
  const freshSessionStore = new SessionStore(path.join(freshRoot, 'sessions'));
  const freshSessionName = 'fresh';
  const invokedFresh: DaemonRequest[] = [];
  const freshInvoke = async (req: DaemonRequest): Promise<DaemonResponse> => {
    invokedFresh.push(req);
    if (req.command === 'open') {
      freshSessionStore.set(freshSessionName, makeIosSession(freshSessionName));
    }
    return { ok: true, data: {} };
  };

  const freshReplay = await runReplayScriptFile({
    req: baseReq({ session: freshSessionName, positionals: [healedPath] }),
    sessionName: freshSessionName,
    logPath: path.join(freshRoot, 'daemon.log'),
    sessionStore: freshSessionStore,
    invoke: freshInvoke,
  });

  expect(freshReplay.ok).toBe(true);
  if (!freshReplay.ok) return;
  const freshData = freshReplay.data as { replayed: number };
  expect(freshData.replayed).toBe(3);
  expect(invokedFresh.map((r) => r.command)).toEqual(['open', 'press', 'click']);
  const openReq = invokedFresh[0]!;
  expect(openReq.positionals).toEqual(['Demo']);
  expect(openReq.flags?.relaunch).toBe(true);
  expect(openReq.runtime).toEqual({ platform: 'ios', metroPort: 8081 });
});
