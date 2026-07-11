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
import type { DaemonResponse } from '../../types.ts';
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
  const resume = divergence.resume as { allowed: boolean; from: number; planDigest: string };
  // Step 1 ("open") is a plain action with no control flow and no outputEnv
  // production, so resuming at the failed step (2) is safe.
  expect(resume).toEqual({ allowed: true, from: 2, planDigest: expect.any(String) });
  expect(resume.planDigest).toMatch(/^[0-9a-f]{64}$/);
});

test('a normalized nested failure preserves typed recovery signals on REPLAY_DIVERGENCE', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-recovery-signals-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['click "Save"']);
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    // This shape is already normalized: normalizeError lifted both signals
    // out of details before the replay wrapper receives it.
    invoke: async () => ({
      ok: false,
      error: {
        code: 'DEVICE_IN_USE',
        message: 'The device is temporarily leased.',
        retriable: true,
        supportedOn: 'ios',
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  expect(response.error.retriable).toBe(true);
  expect(response.error.supportedOn).toBe('ios');
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

// --- Control-flow-wrapped include provenance (reviewer probe scenario) ---
//
// The RN suite's own launch include is retry-wrapped, so the single most
// common real failure site (a launch wait timeout inside the include) must
// report the INCLUDE's file+line, not the wrapping `retry:`/`runFlow.when:`
// line in the root flow. Regression for the leak where replayControl.actions
// kept the transient replaySource field but the runtime never consulted it.

function writeMaestroInclude(root: string): string {
  const childPath = path.join(root, 'child.yaml');
  fs.writeFileSync(
    childPath,
    ['appId: com.callstack.agentdevicelab', '---', '- back', ''].join('\n'),
  );
  return childPath;
}

test('a failure inside a retry-wrapped runFlow include reports the include file and line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-retry-provenance-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const childPath = writeMaestroInclude(root);
  const mainPath = path.join(root, 'main.yaml');
  fs.writeFileSync(
    mainPath,
    [
      'appId: com.callstack.agentdevicelab',
      '---',
      '- retry:',
      '    maxRetries: 1',
      '    commands:',
      '      - runFlow:',
      '          file: child.yaml',
      '',
    ].join('\n'),
  );
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [mainPath], flags: { replayBackend: 'maestro' } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'back') {
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'back failed' } };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  const step = divergence.step as { index: number; source: { path: string; line: number } };
  // Plan index 1: the retry wrapper is one executable-plan step; the source
  // names the failing NESTED action inside the include, not the retry: line.
  expect(step.index).toBe(1);
  expect(step.source.path).toBe(childPath);
  expect(step.source.line).toBe(3);
  // The transport-internal provenance marker is stripped from the flat details.
  expect(response.error.details?.replaySource).toBeUndefined();
});

test('a failure inside a runtime runFlow.when-wrapped include reports the include file and line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-when-provenance-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const childPath = writeMaestroInclude(root);
  const mainPath = path.join(root, 'main.yaml');
  fs.writeFileSync(
    mainPath,
    [
      'appId: com.callstack.agentdevicelab',
      '---',
      '- runFlow:',
      '    file: child.yaml',
      '    when:',
      '      notVisible: Continue',
      '',
    ].join('\n'),
  );
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [mainPath], flags: { replayBackend: 'maestro' } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      // The notVisible condition captures a snapshot; an empty tree means the
      // selector is absent, so the wrapped steps run.
      if (req.command === 'snapshot') return { ok: true, data: { nodes: [] } };
      if (req.command === 'back') {
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'back failed' } };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  const step = divergence.step as { index: number; source: { path: string; line: number } };
  expect(step.index).toBe(1);
  expect(step.source.path).toBe(childPath);
  expect(step.source.line).toBe(3);
  expect(response.error.details?.replaySource).toBeUndefined();
});
