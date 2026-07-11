import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runReplayScriptFile } from '../session-replay-runtime.ts';
import { buildReplayFailureDivergence } from '../session-replay-divergence.ts';
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

test('divergence cause and action strings pass through the central redactor at construction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-divergence-redact-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['click "Save"']);
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'request rejected: api_key=sk-live-abc123def456 invalid',
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  const divergence = response.error.details?.divergence as Record<string, unknown>;
  const cause = divergence.cause as { message: string };
  expect(cause.message).not.toContain('sk-live-abc123def456');
  expect(cause.message).toContain('api_key=[REDACTED]');
});

// --- Blocker 1: fill text must NEVER appear in the divergence output ---

test('a fill divergence never serializes the typed text at any response level', async () => {
  const sentinel = 'SuperSecretPassword-do-not-leak-12345';
  for (const level of ['digest', 'default', 'full'] as const) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-fill-leak-'));
    const sessionStore = new SessionStore(path.join(root, 'sessions'));
    const sessionName = 'default';
    sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
    const filePath = writeReplayFile(root, [`fill 'label="Email"' ${JSON.stringify(sentinel)}`]);
    // Selector miss forces the divergence on the fill step; the failure
    // message is a realistic selector error, not an echo of the typed text.
    mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

    const response = await runReplayScriptFile({
      req: baseReq({ positionals: [filePath], meta: { responseLevel: level } }),
      sessionName,
      logPath: path.join(root, 'daemon.log'),
      sessionStore,
      invoke: async (req) => {
        if (req.command === 'fill') {
          // A REAL fill-verification failure carries the entered text in
          // details.expected (unmasked fields do, by the fill-diagnostics
          // contract) — the divergence transport must strip it categorically.
          return {
            ok: false,
            error: {
              code: 'COMMAND_FAILED',
              message: 'Android fill verification failed',
              details: {
                expected: sentinel,
                actual: sentinel.slice(0, 10),
                failureReason: 'text_mismatch',
              },
            },
          };
        }
        return { ok: true, data: {} };
      },
    });

    expect(response.ok).toBe(false);
    if (response.ok) return;
    const serializedDivergence = JSON.stringify(response.error.details?.divergence);
    expect(serializedDivergence).not.toContain(sentinel);
    // The WHOLE public error (flat details incl. the cause's own
    // details.expected/actual, positionals, message) must not leak it either.
    expect(JSON.stringify(response.error)).not.toContain(sentinel);
    expect(JSON.stringify(response.error)).not.toContain(sentinel.slice(0, 10));
    // The action label still names the field, with the text categorically hidden.
    const divergence = response.error.details?.divergence as { action: string };
    expect(divergence.action).toContain('<text>');
    expect(divergence.action).toContain('Email');
  }
});

// --- Blocker 3b: suggestion dedupe keeps the STRONGEST basis per node ---

test('a divergence dedupes suggestions by node and tags the strongest basis', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-suggest-dedupe-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));

  // A recorded click whose selectorChain lists a label-basis term FIRST and an
  // id-basis term SECOND, both resolving to the same node. The suggestion must
  // appear once, tagged with the stronger `id` basis (not the first-seen label).
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Save',
        identifier: 'save',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const divergence = await buildReplayFailureDivergence({
    error: { code: 'COMMAND_FAILED', message: 'not hittable' },
    action: {
      ts: 0,
      command: 'click',
      positionals: ['label="Save"'],
      flags: {},
      result: { selectorChain: ['label="Save"', 'id="save"'] },
    },
    index: 0,
    sourcePath: path.join(root, 'flow.ad'),
    sourceLine: 1,
    session: sessionStore.get(sessionName),
    sessionName,
    sessionStore,
    logPath: path.join(root, 'daemon.log'),
    responseLevel: 'default',
    planActions: [
      {
        ts: 0,
        command: 'click',
        positionals: ['label="Save"'],
        flags: {},
        result: { selectorChain: ['label="Save"', 'id="save"'] },
      },
    ],
    planDigest: 'test-plan-digest',
  });

  expect(divergence.suggestionCount).toBe(1);
  expect(divergence.suggestions).toHaveLength(1);
  expect(divergence.suggestions[0]?.ref).toBe('e1');
  expect(divergence.suggestions[0]?.basis).toBe('id');
});

// --- Blocker 3a: capture-error screen hint is sanitized ---

test('a capture-failed screen hint redacts a secret in the capture error', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-screen-redact-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['click "Save"']);
  // The post-failure snapshot capture throws with a secret-bearing message.
  mockDispatchCommand.mockRejectedValue(new Error('snapshot failed: api_key=sk-live-abc123def456'));

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
  const divergence = response.error.details?.divergence as {
    screen: { state: string; reason?: string; hint?: string };
  };
  expect(divergence.screen.state).toBe('unavailable');
  expect(divergence.screen.reason).toBe('capture-failed');
  expect(divergence.screen.hint).not.toContain('sk-live-abc123def456');
  expect(divergence.screen.hint).toContain('[REDACTED]');
});

// --- Expanded replay variables are never serialized (ADR 0012) ---

test('an expanded ${VAR} value echoed by a selector error never reaches the public divergence', async () => {
  const sentinel = 'ExpandedVarSecret-98765-do-not-leak';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-var-leak-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['press label="${SECRET}"']);
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayEnv: [`SECRET=${sentinel}`] } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'press') {
        // A real selector miss echoes the RESOLVED (expanded) selector.
        return {
          ok: false,
          error: {
            code: 'COMMAND_FAILED',
            message: `Selector did not match: ${req.positionals?.[0] ?? ''}`,
            hint: `Run find "${sentinel}" for contains matching.`,
          },
        };
      }
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  // The expanded value appears nowhere in the whole public error.
  expect(JSON.stringify(response.error)).not.toContain(sentinel);
  // The scrub is a marker replacement, not a drop: the caller still sees
  // WHICH variable the selector interpolated.
  const divergence = response.error.details?.divergence as {
    cause: { message: string; hint?: string };
  };
  expect(divergence.cause.message).toContain('<var:SECRET>');
  expect(divergence.cause.hint).toContain('<var:SECRET>');
  expect(response.error.message).toContain('<var:SECRET>');
});

test('an expanded built-in AD_DEVICE_ID never reaches the public divergence', async () => {
  const deviceId = 'BuiltInDeviceId-486b3d4c-8f92-4dc0-b5c6-unique';
  const sessionName = 'static-session-context';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-builtin-var-leak-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  const filePath = writeReplayFile(root, ['press label="${AD_DEVICE_ID}"']);
  mockDispatchCommand.mockRejectedValue(new Error('no device runner available'));

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { serial: deviceId } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => ({
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: `Device ${req.positionals?.[0] ?? ''} failed in ${sessionName} context.`,
      },
    }),
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(JSON.stringify(response.error)).not.toContain(deviceId);
  expect(response.error.message).toContain('<var:AD_DEVICE_ID>');
  // AD_SESSION was not expanded, so matching static text remains readable.
  expect(response.error.message).toContain(sessionName);
});

// --- ADR 0012 decision 4 / migration step 5: replay resume (`--from` + `--plan-digest`) ---

test('resume skips steps 1..from-1 without invoking them and executes only from the reported step', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-skip-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, [
    'open "Demo"',
    'click label="Continue"',
    'click label="Save"',
  ]);

  // First attempt: step 3 fails, capturing a real resume report.
  const firstAttempt = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'click' && req.positionals?.[0] === 'label="Save"') {
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'not hittable' } };
      }
      return { ok: true, data: {} };
    },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string };
  };
  expect(divergence.resume.allowed).toBe(true);
  expect(divergence.resume.from).toBe(3);

  // Second attempt: repair app state, resume at the reported step. Steps 1-2
  // must never be invoked — the mock throws if they are.
  const invokedCommands: string[] = [];
  const resumedAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayFrom: divergence.resume.from, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      invokedCommands.push(`${req.command} ${req.positionals?.[0] ?? ''}`.trim());
      if (req.command === 'open' || req.positionals?.[0] === 'label="Continue"') {
        throw new Error('resume must not re-invoke a skipped step');
      }
      return { ok: true, data: {} };
    },
  });

  expect(resumedAttempt.ok).toBe(true);
  if (!resumedAttempt.ok) return;
  expect(invokedCommands).toEqual(['click label="Save"']);
  const data = resumedAttempt.data as { replayed: number };
  expect(data.replayed).toBe(1);
});

test('resume requires both --from and --plan-digest together', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-pair-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const fromOnly = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayFrom: 2 } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute before the flag-pair preflight');
    },
  });
  expect(fromOnly.ok).toBe(false);
  if (!fromOnly.ok) expect(fromOnly.error.code).toBe('INVALID_ARGS');

  const digestOnly = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath], flags: { replayPlanDigest: 'deadbeef' } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute before the flag-pair preflight');
    },
  });
  expect(digestOnly.ok).toBe(false);
  if (!digestOnly.ok) expect(digestOnly.error.code).toBe('INVALID_ARGS');
});

test('resume rejects an out-of-range --from before any action', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-range-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayFrom: 99, replayPlanDigest: 'deadbeef' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute an out-of-range resume');
    },
  });
  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/out of range/);
});

test('resume rejects a stale --plan-digest after the script changed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-stale-digest-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const filePath = writeReplayFile(root, ['open "Demo"', 'click "Save"']);

  const firstAttempt = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command === 'click') {
        return { ok: false, error: { code: 'COMMAND_FAILED', message: 'not hittable' } };
      }
      return { ok: true, data: {} };
    },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string };
  };

  // Edit the script (an extra step) before resuming: the digest must no
  // longer match.
  fs.writeFileSync(filePath, 'open "Demo"\nclick "Extra"\nclick "Save"\n');

  const resumedAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [filePath],
      flags: { replayFrom: divergence.resume.from, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute on a plan-digest mismatch');
    },
  });
  expect(resumedAttempt.ok).toBe(false);
  if (resumedAttempt.ok) return;
  expect(resumedAttempt.error.code).toBe('INVALID_ARGS');
  expect(resumedAttempt.error.message).toMatch(/plan digest/);
});

test('resume rejects resuming past a retry-wrapped step in the skipped range', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-resume-control-flow-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const mainPath = path.join(root, 'main.yaml');
  fs.writeFileSync(
    mainPath,
    [
      'appId: com.callstack.agentdevicelab',
      '---',
      '- retry:',
      '    maxRetries: 1',
      '    commands:',
      '      - back',
      '- back',
      '',
    ].join('\n'),
  );

  // `back` has no Maestro-specific runtime handling, so it reaches `invoke`
  // directly — the retry block's nested `back` (1st call) succeeds; the
  // top-level step-2 `back` (2nd call) fails.
  let backCalls = 0;
  const firstAttempt = await runReplayScriptFile({
    req: baseReq({ positionals: [mainPath], flags: { replayBackend: 'maestro' } }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (req) => {
      if (req.command !== 'back') return { ok: true, data: {} };
      backCalls += 1;
      if (backCalls === 1) return { ok: true, data: {} };
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'back failed' } };
    },
  });
  expect(firstAttempt.ok).toBe(false);
  if (firstAttempt.ok) return;
  const divergence = firstAttempt.error.details?.divergence as {
    resume: { allowed: boolean; from: number; planDigest: string; reason?: string };
  };
  // Step 2 (tapOn: Save) is the reported failure; resuming there means
  // skipping step 1, the retry block.
  expect(divergence.resume.from).toBe(2);
  expect(divergence.resume.allowed).toBe(false);
  expect(divergence.resume.reason).toMatch(/control flow/);

  const resumedAttempt = await runReplayScriptFile({
    req: baseReq({
      positionals: [mainPath],
      flags: {
        replayBackend: 'maestro',
        replayFrom: divergence.resume.from,
        replayPlanDigest: divergence.resume.planDigest,
      },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async () => {
      throw new Error('must not execute a resume the preflight rejected');
    },
  });
  expect(resumedAttempt.ok).toBe(false);
  if (resumedAttempt.ok) return;
  expect(resumedAttempt.error.code).toBe('INVALID_ARGS');
  expect(resumedAttempt.error.message).toMatch(/control flow/);
});

// --- Migrated from the retired replay-heal.test.ts: general parse-time rejections ---

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
