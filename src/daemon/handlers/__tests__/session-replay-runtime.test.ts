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

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});
test('a successful replay prints one line with the step count and wall time', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-success-message-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const data = response.data as { replayed: number; message: string };
  expect(data.replayed).toBe(2);
  expect(data.message).toMatch(/^Replayed 2 steps in \d+\.\ds$/);
});
test('replay rejects legacy JSON payload files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-json-rejected-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = path.join(root, 'replay.json');
  fs.writeFileSync(filePath, JSON.stringify({ optimizedActions: [] }, null, 2));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/\.ad script files/);
});

test('replay rejects malformed .ad lines with unclosed quotes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-invalid-ad-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['click "id=\\"broken\\"']);

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/Invalid replay script line/);
});

// --- ADR 0012 decision 1 / migration step 6: `--update` retirement ---

test('--update never rewrites the .ad file, even when a re-resolvable suggestion exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-update-no-write-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['click label="Save"']);
  const before = fs.readFileSync(filePath, 'utf8');
  const statBefore = fs.statSync(filePath);

  // The recorded selector still structurally matches a fresh node — exactly
  // the case the old heal-and-rewrite arm would have silently applied.
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Save',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayUpdate: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'not hittable' },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  // The file on disk is byte-for-byte unchanged.
  expect(fs.readFileSync(filePath, 'utf8')).toBe(before);
  expect(fs.statSync(filePath).mtimeMs).toBe(statBefore.mtimeMs);
  // The bounded suggestions the ADR mandates are still there — --update did
  // not lose functionality, it lost the unattended rewrite.
  const divergence = response.error.details?.divergence as {
    suggestions: Array<{ selector: string; basis: string }>;
  };
  expect(divergence.suggestions.length).toBeGreaterThan(0);
});

test('a successful --update replay reports healed: 0 (heal is retired, not just quiet)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-update-healed-zero-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayUpdate: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(true);
  if (!response.ok) return;
  const data = response.data as { healed: number };
  expect(data.healed).toBe(0);
});

test('--update no longer refuses env directives (the guard existed only for rewrite safety)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-update-env-ok-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['env NAME=World', 'open "Demo"']);

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayUpdate: true } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(true);
});

test('--update no longer refuses ${VAR} interpolation (the guard existed only for rewrite safety)', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-update-interp-ok-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['click label="${NAME}"']);

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayUpdate: true, replayEnv: ['NAME=World'] },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(true);
});
