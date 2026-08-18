import { test, expect, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

/**
 * #1555 structural-quality review ("topology fix... its subject now lives
 * in the engine's step-loop/terminal logic — either move it into the
 * package tests if it tests engine policy through the façade, or rename to
 * match the daemon file it actually exercises"): renamed from
 * `session-replay-terminal-lifecycle.test.ts`, a name inherited from a
 * production module (`session-replay-terminal-lifecycle.ts`) the #1554
 * fold-in already deleted (`step-loop.ts`'s own header documents the
 * deletion — its terminal-close-suppression decision unified into the
 * engine's `resolveSuppressedTerminalCloseIndex`).
 *
 * These six cases stayed daemon-side rather than moving into the package's
 * `step-loop.test.ts` because they are NOT a test of engine policy through
 * the façade in isolation — every one drives the full
 * `runReplayScriptSource` round trip against a REAL `SessionStore`, and two of
 * the six (`--keep-session fails explicitly when the completed replay has
 * no live session`, `--keep-session rejects Maestro YAML before engine
 * dispatch`) exercise daemon-ONLY authority
 * (`requireLiveSessionForKeepSession`'s postcondition, `routeMaestroReplay`'s
 * routing) that never reaches the engine's step loop at all. The engine's
 * OWN terminal-close-suppression decision has its own cheaper, direct
 * coverage in `packages/ad-replay/src/internal/__tests__/step-loop.test.ts`
 * (see that file's header). This file's real subject is
 * `session-replay-runtime.ts`'s `runReplayScriptSource` — specifically its
 * `--keep-session` behavior — so it is named and grouped alongside that
 * file's other `session-replay-runtime-*.test.ts` siblings
 * (`-plan.test.ts`, `-maestro.test.ts`, `-failure.test.ts`, …) rather than
 * kept in its own differently-named file or folded into the already-629-line
 * `session-replay-runtime.test.ts`.
 */

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});

import fs from 'node:fs';
import path from 'node:path';
import { runReplayScriptSource } from '../session-replay-runtime.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest } from '../../types.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from './session-replay-runtime.fixtures.ts';

test('--keep-session suppresses a close that is terminal among executable actions', async () => {
  const root = mkdtempForTestSync('agent-device-replay-keep-marker-tail-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'close', 'replay "./nested-flow.ad"']);
  const commands: string[] = [];

  const response = await runReplayScriptSource({
    req: baseReq({ positionals: [filePath], flags: { replayKeepSession: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      commands.push(req.command);
      if (req.command === 'close') sessionStore.delete(sessionName);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(commands).toEqual(['open']);
  if (!response.ok) return;
  expect(response.data).toMatchObject({ sessionActive: true, replayed: 1 });
});

test('--keep-session fails explicitly when the completed replay has no live session', async () => {
  const root = mkdtempForTestSync('agent-device-replay-keep-postcondition-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Log out"']);

  const response = await runReplayScriptSource({
    req: baseReq({ positionals: [filePath], flags: { replayKeepSession: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'click') sessionStore.delete(sessionName);
      return { ok: true, data: {} };
    },
  });

  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: expect.stringContaining('--keep-session could not preserve session'),
    },
  });
});

test('--keep-session suppresses only the authored terminal close and reports the surviving session', async () => {
  const root = mkdtempForTestSync('agent-device-replay-keep-session-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"', 'close']);
  const commands: string[] = [];

  const response = await runReplayScriptSource({
    req: baseReq({ positionals: [filePath], flags: { replayKeepSession: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      commands.push(req.command);
      if (req.command === 'close') sessionStore.delete(sessionName);
      return { ok: true, data: {} };
    },
  });

  expect(commands).toEqual(['open', 'click']);
  expect(response.ok).toBe(true);
  if (!response.ok) return;
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(response.data).toMatchObject({ sessionActive: true, replayed: 2 });
});

test('--keep-session preserves an interior close instead of broad command filtering', async () => {
  const root = mkdtempForTestSync('agent-device-replay-keep-interior-close-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'close', 'open "Next"']);
  const commands: string[] = [];

  const response = await runReplayScriptSource({
    req: baseReq({ positionals: [filePath], flags: { replayKeepSession: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      commands.push(req.command);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(commands).toEqual(['open', 'close', 'open']);
});

test('--keep-session is a no-op for an already close-less script', async () => {
  const root = mkdtempForTestSync('agent-device-replay-keep-close-less-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);
  const invoke = vi.fn(async (_req: DaemonRequest) => ({ ok: true as const, data: {} }));

  const response = await runReplayScriptSource({
    req: baseReq({ positionals: [filePath], flags: { replayKeepSession: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response.ok).toBe(true);
  expect(invoke.mock.calls.map(([req]) => req.command)).toEqual(['open', 'click']);
  if (!response.ok) return;
  expect((response.data as { sessionActive: boolean }).sessionActive).toBe(true);
});

test('--keep-session rejects Maestro YAML before engine dispatch', async () => {
  const root = mkdtempForTestSync('agent-device-replay-keep-maestro-');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = path.join(root, 'flow.yaml');
  fs.writeFileSync(filePath, ['appId: com.example.app', '---', '- launchApp'].join('\n'));
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  const response = await runReplayScriptSource({
    req: baseReq({
      positionals: [filePath],
      flags: { replayBackend: 'maestro', replayKeepSession: true },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', message: expect.stringContaining('--keep-session') },
  });
  expect(invoke).not.toHaveBeenCalled();
});
