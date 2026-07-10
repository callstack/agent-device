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
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { dispatchCommand } from '../../../core/dispatch.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
});

function writeReplayFile(root: string, lines: string[]): string {
  const filePath = path.join(root, 'flow.ad');
  fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

function baseReq(overrides: Partial<DaemonRequest> = {}): DaemonRequest {
  return {
    token: 'token',
    session: 'default',
    command: 'replay',
    positionals: [],
    ...overrides,
  };
}

test('a failing replay step returns REPLAY_DIVERGENCE with cause preserved and correct step provenance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  // The post-failure screen digest capture (and the suggestions re-resolution
  // capture) both go through dispatchCommand('snapshot', ...); with no real
  // device backend in a unit test, this throws, so screen must degrade to
  // 'unavailable' rather than masking the original replay cause.
  mockDispatchCommand.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') throw new Error('no device runner available');
    return { ok: true };
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'open') return { ok: true, data: { session: sessionName } };
      if (req.command === 'click') {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'Selector did not match', hint: 'Run find.' },
        };
      }
      throw new Error(`unexpected command ${req.command}`);
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  // The legacy flat fields survive additively for existing consumers.
  expect(response.error.details?.step).toBe(2);
  expect(response.error.details?.action).toBe('click');

  const divergence = response.error.details?.divergence as Record<string, unknown>;
  expect(divergence.version).toBe(1);
  expect(divergence.kind).toBe('action-failure');
  const step = divergence.step as { index: number; source: { path: string; line: number } };
  expect(step.index).toBe(2);
  expect(step.source.path).toBe(filePath);
  expect(step.source.line).toBe(2);

  const cause = divergence.cause as { code: string; message: string; hint?: string };
  expect(cause.code).toBe('COMMAND_FAILED');
  expect(cause.message).toBe('Selector did not match');
  expect(cause.hint).toBe('Run find.');

  const screen = divergence.screen as { state: string; reason?: string };
  expect(screen.state).toBe('unavailable');
  expect(screen.reason).toBe('capture-failed');

  expect(divergence.suggestions).toEqual([]);
  expect(divergence.suggestionCount).toBe(0);
  expect(divergence.resume).toEqual({ allowed: false, reason: 'resume not yet supported' });
});

test('a failing replay step captures an available screen digest with blessed refs', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-screen-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['click "Save"']);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Cancel',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'Selector did not match' },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  const screen = divergence.screen as {
    state: string;
    refsGeneration: number;
    refs: Array<{ ref: string; role: string; label?: string }>;
  };
  expect(screen.state).toBe('available');
  expect(typeof screen.refsGeneration).toBe('number');
  expect(screen.refs).toEqual([{ ref: 'e1', role: 'button', label: 'Cancel' }]);
});

test('a failing replay step ranks a re-resolved suggestion when the recorded selector still matches', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-suggest-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  // The recorded selector is label-only, so it still structurally matches a
  // node in the fresh capture even though the underlying tap failed (e.g. the
  // node moved off-screen or was momentarily not hittable) — the exact class
  // heal could recover, now surfaced as a read-only suggestion instead.
  const filePath = writeReplayFile(root, ['click label="Save"']);

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
    req: baseReq({ positionals: [filePath] }),
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
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  const suggestions = divergence.suggestions as Array<{
    selector: string;
    basis: string;
    ref?: string;
  }>;
  expect(divergence.suggestionCount).toBe(1);
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]?.ref).toBe('e1');
  expect(suggestions[0]?.basis).toBe('label');
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

test('divergence screen never masks the original cause when the session already closed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-no-session-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  // Intentionally no session stored: simulates the session closing mid-replay.
  const filePath = writeReplayFile(root, ['click "Save"']);

  const response: DaemonResponse = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'session closed mid-replay' },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  const cause = divergence.cause as { message: string };
  expect(cause.message).toBe('session closed mid-replay');
  const screen = divergence.screen as { state: string; reason?: string };
  expect(screen.state).toBe('unavailable');
  expect(screen.reason).toBe('no-session');
});
