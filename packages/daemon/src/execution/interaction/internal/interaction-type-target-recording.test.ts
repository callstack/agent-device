import type { CommandFlags } from '@agent-device/contracts/command';
import { attachRefs, type RawSnapshotNode } from '@agent-device/kernel/snapshot';
import { beforeEach, expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { handleInteractionCommands } from '../index.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import {
  authoringPublication,
  makeIosAppSession,
} from '../../../__tests__/support/session-factories.ts';
import { SessionScriptWriter } from '../../../core/session-script-writer.ts';
import { activateCompleteRefFrame } from '../../../core/ref-frame.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { runReplayForTest } from '../../../sessions/__tests__/replay-runtime/replay-command-fixture.ts';
import { replayScriptSourceBundleFor } from '../../../__tests__/support/replay-script-source-fixture.ts';
import { createLiveTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import {
  installInteractorSnapshotResolution,
  mockInteractorSnapshot,
} from '../../../__tests__/support/interactor-resolution-fixture.ts';
import { touchCreateCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import {
  getRuntimeBindings,
  mockTapPoint,
  mockTypeText,
  resetGetRuntimeFixture,
} from '../../__tests__/interaction-get-runtime-fixture.ts';

// PR #4870 acceptance: a targetless `type` must record its ORIGINAL positionals, so the saved
// script replays the same argument boundaries. The replay's mistargeted-ref check reads only the
// first positional, so a folded `["  @e2"]` step trims into a ref the daemon refuses. A targeted
// `type` keeps folding its text into ONE positional, so a replayed type step cannot re-split the
// payload into a target. Each test walks the full record -> save -> replay round trip.

/** The one text field every session here carries; its minted ref is `@e1`. */
const TEXTBOX_NODES: RawSnapshotNode[] = [
  {
    index: 0,
    type: 'XCUIElementTypeTextField',
    label: 'Email',
    identifier: 'auth_email',
    rect: { x: 44, y: 120, width: 200, height: 32 },
    enabled: true,
    hittable: true,
  },
];

/**
 * What the fixed execution types for the maintainer's prove-the-fix input: the two positionals
 * joined by one space. The literal is spelled as a join so the two spaces stay visible beside the
 * `[' ', '@e2']` input.
 */
const joinedTargetlessText = [' ', '@e2'].join(' ');

const contextFromFlags = (flags: CommandFlags | undefined) => ({
  count: flags?.count,
  intervalMs: flags?.intervalMs,
  delayMs: flags?.delayMs,
  holdMs: flags?.holdMs,
  jitterPx: flags?.jitterPx,
  doubleTap: flags?.doubleTap,
  clickButton: flags?.clickButton,
});

/** An ARMED recording session whose snapshot mints `@e1` on the text field. */
function publishTextboxSession(
  sessionStore: ReturnType<typeof makeSessionStore>,
  name: string,
): void {
  const session = makeIosAppSession(name, {
    scriptPublication: authoringPublication('armed'),
  });
  session.snapshot = {
    nodes: attachRefs(TEXTBOX_NODES),
    createdAt: Date.now(),
    backend: 'xctest',
  };
  activateCompleteRefFrame(session);
  sessionStore.publish(name, session);
}

async function runType(
  sessionStore: ReturnType<typeof makeSessionStore>,
  sessionName: string,
  positionals: string[],
): Promise<Awaited<ReturnType<typeof handleInteractionCommands>>> {
  return await handleInteractionCommands({
    createCommandSurface: touchCreateCommandSurface,
    req: { token: 't', session: sessionName, command: 'type', positionals, flags: {} },
    sessionName,
    sessionStore,
    contextFromFlags,
    ...getRuntimeBindings(),
  });
}

function writeSessionScript(
  session: SessionState,
  root: string,
): { scriptPath: string; savedScript: string } {
  const written = new SessionScriptWriter(
    path.join(root, 'sessions'),
    createLiveTestHostEnvironment().cwd,
  ).write(session);
  expect(written.written).toBe(true);
  if (!written.written) throw new Error('expected the script to be written');
  return {
    scriptPath: written.path,
    savedScript: fs.readFileSync(written.path, 'utf8'),
  };
}

/** The saved script's `type` lines, line-bounded so annotations cannot blur the assertion. */
function recordedTypeLines(savedScript: string): string[] {
  return savedScript.split('\n').filter((line) => line.startsWith('type '));
}

async function replaySavedScript(
  root: string,
  scriptPath: string,
): Promise<Awaited<ReturnType<typeof runReplayForTest>>> {
  const replaySessionName = 'type-recording-replay';
  const replayStore = makeSessionStore();
  replayStore.publish(replaySessionName, makeIosAppSession(replaySessionName));
  return await runReplayForTest({
    req: {
      token: 'test',
      session: replaySessionName,
      command: 'replay',
      positionals: [scriptPath],
      flags: {
        replayKeepSession: true,
        replayScriptSource: replayScriptSourceBundleFor(scriptPath),
      },
    },
    sessionName: replaySessionName,
    logPath: path.join(root, 'replay-daemon.log'),
    sessionStore: replayStore,
    invoke: async (req) => {
      const response = await handleInteractionCommands({
        createCommandSurface: touchCreateCommandSurface,
        req,
        sessionName: replaySessionName,
        sessionStore: replayStore,
        contextFromFlags,
        ...getRuntimeBindings(),
      });
      if (!response) throw new Error(`unexpected empty response for ${req.command}`);
      return response;
    },
  });
}

beforeEach(() => {
  resetGetRuntimeFixture();
  installInteractorSnapshotResolution();
  mockInteractorSnapshot.mockReset();
});

// P1 + P2 (the maintainer's prove-the-fix): record `type " " @e2`, save the script, replay it.
test('a targetless type records its two positionals and its saved script replays without INVALID_ARGS', async () => {
  const root = mkdtempForTestSync('agent-device-type-recording-');
  const sessionName = 'targetless-type-recording';
  const sessionStore = makeSessionStore();
  publishTextboxSession(sessionStore, sessionName);

  const recordedResponse = await runType(sessionStore, sessionName, [' ', '@e2']);
  expect(recordedResponse).toMatchObject({ ok: true });

  // P1: the recording keeps the original argument boundaries, and a targetless type taps nothing.
  expect(mockTapPoint).not.toHaveBeenCalled();
  expect(mockTypeText).toHaveBeenCalledTimes(1);
  const recordedSession = sessionStore.get(sessionName);
  if (!recordedSession) throw new Error('expected the session to persist');
  expect(recordedSession.actions).toHaveLength(1);
  expect(recordedSession.actions[0]).toMatchObject({
    command: 'type',
    positionals: [' ', '@e2'],
  });

  const { scriptPath, savedScript } = writeSessionScript(recordedSession, root);
  expect(recordedTypeLines(savedScript)).toEqual(['type " " @e2']);
  // The folded single-token shape is the regression this file pins out of the recorder.
  expect(savedScript).not.toContain('type "  @e2"');

  // P2: the saved script replays cleanly and types the same joined text.
  mockTapPoint.mockClear();
  mockTypeText.mockClear();
  const replayResponse = await replaySavedScript(root, scriptPath);
  expect(replayResponse).toMatchObject({ ok: true });
  expect(mockTapPoint).not.toHaveBeenCalled();
  expect(mockTypeText).toHaveBeenCalledTimes(1);
  expect(mockTypeText.mock.calls[0]?.[0]).toMatchObject({ text: joinedTargetlessText });
});

// P3 regression protection: a targeted recording stays two actions (the focus press, then the
// text folded into ONE positional), and its saved script replays with no tap from the type step.
test('a targeted type still folds its text into one positional and its saved script replays without a second tap', async () => {
  const root = mkdtempForTestSync('agent-device-type-recording-targeted-');
  const sessionName = 'targeted-type-recording';
  const sessionStore = makeSessionStore();
  publishTextboxSession(sessionStore, sessionName);

  const recordedResponse = await runType(sessionStore, sessionName, ['@e1', 'hello']);
  expect(recordedResponse).toMatchObject({ ok: true });

  // P3: the targeted recording keeps the focus press and folds the text into one positional.
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTypeText).toHaveBeenCalledTimes(1);
  expect(mockTypeText.mock.calls[0]?.[0]).toMatchObject({ text: 'hello' });
  const recordedSession = sessionStore.get(sessionName);
  if (!recordedSession) throw new Error('expected the session to persist');
  expect(recordedSession.actions).toHaveLength(2);
  expect(recordedSession.actions[0]).toMatchObject({ command: 'press', positionals: ['@e1'] });
  expect(recordedSession.actions[1]).toMatchObject({
    command: 'type',
    positionals: ['hello'],
  });

  const { scriptPath, savedScript } = writeSessionScript(recordedSession, root);
  expect(recordedTypeLines(savedScript)).toEqual(['type "hello"']);

  // The replay's press step resolves its recorded selector against a fresh capture.
  mockInteractorSnapshot.mockResolvedValue({
    backend: 'xctest',
    producer: 'apple-runner',
    nodes: attachRefs(TEXTBOX_NODES),
    quality: { state: 'healthy', backend: 'tree' },
  });
  mockTapPoint.mockClear();
  mockTypeText.mockClear();
  const replayResponse = await replaySavedScript(root, scriptPath);
  expect(replayResponse).toMatchObject({ ok: true });
  // The press step taps once; the replayed type step adds NO second tap.
  expect(mockTapPoint).toHaveBeenCalledTimes(1);
  expect(mockTypeText).toHaveBeenCalledTimes(1);
  expect(mockTypeText.mock.calls[0]?.[0]).toMatchObject({ text: 'hello' });
});
