import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})), resolveTargetDevice: vi.fn() };
});
vi.mock('../../device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CommandFlags } from '../../../core/dispatch.ts';
import { handleSessionCommands } from '../session.ts';
import { healReplayAction } from '../session-replay-heal.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, DaemonResponse, SessionAction } from '../../types.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { dispatchCommand, resolveTargetDevice } from '../../../core/dispatch.ts';
import { ensureDeviceReady } from '../../device-ready.ts';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';

const mockDispatchCommand = vi.mocked(dispatchCommand);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);

beforeEach(() => {
  mockDispatchCommand.mockReset();
  mockDispatchCommand.mockResolvedValue({});
  mockResolveTargetDevice.mockReset();
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockResolvedValue(undefined);
});

function makeSession(name: string) {
  return makeIosSession(name, { appBundleId: 'com.example.app' });
}

function writeReplayFile(filePath: string, action: SessionAction) {
  const args = action.positionals.map((value) => JSON.stringify(value)).join(' ');
  fs.writeFileSync(filePath, `${action.command}${args.length > 0 ? ` ${args}` : ''}\n`);
}

function readReplaySelector(filePath: string, command: string): string {
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const line = lines.find((entry) => entry.startsWith(`${command} `) || entry === command);
  if (!line) return '';
  const args = tokenizeReplayLine(line).slice(1);
  if (command === 'is') {
    return args[1] ?? '';
  }
  return args[0] ?? '';
}

function tokenizeReplayLine(line: string): string[] {
  const tokens: string[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    while (cursor < line.length && /\s/.test(line[cursor]!)) {
      cursor += 1;
    }
    if (cursor >= line.length) break;
    if (line[cursor] === '"') {
      let end = cursor + 1;
      let escaped = false;
      while (end < line.length) {
        const char = line[end];
        if (char === '"' && !escaped) break;
        escaped = char === '\\' && !escaped;
        if (char !== '\\') escaped = false;
        end += 1;
      }
      if (end >= line.length) {
        throw new Error(`Invalid replay script line: ${line}`);
      }
      tokens.push(JSON.parse(line.slice(cursor, end + 1)) as string);
      cursor = end + 1;
      continue;
    }
    let end = cursor;
    while (end < line.length && !/\s/.test(line[end]!)) {
      end += 1;
    }
    tokens.push(line.slice(cursor, end));
    cursor = end;
  }
  return tokens;
}

test('replay heal snapshot refresh clears stale scoped snapshot source', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-scope-source-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-scope-source-session';
  const session = makeSession(sessionName);
  session.snapshotScopeSource = {
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Stale button',
      },
    ],
    createdAt: Date.now(),
    backend: 'xctest',
  };
  sessionStore.set(sessionName, session);

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        label: 'Continue',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const healed = await healReplayAction({
    action: {
      ts: Date.now(),
      command: 'click',
      positionals: ['label="Continue"'],
      flags: {},
      result: {},
    },
    sessionName,
    logPath: '/tmp/replay.log',
    sessionStore,
  });

  expect(healed?.positionals[0]).toContain('label="Continue"');
  expect(sessionStore.get(sessionName)?.snapshotScopeSource).toBeUndefined();
});

test('replay heal rewrites longpress selector and preserves duration', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-longpress-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-longpress-session';
  sessionStore.set(sessionName, makeSession(sessionName));

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'XCUIElementTypeStaticText',
        label: 'Last message',
        identifier: 'message_last',
        rect: { x: 0, y: 0, width: 100, height: 44 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const healed = await healReplayAction({
    action: {
      ts: Date.now(),
      command: 'longpress',
      positionals: ['id="old_message" || label="Last message"', '800'],
      flags: {},
      result: { selectorChain: ['id="old_message"', 'label="Last message"'], durationMs: 800 },
    },
    sessionName,
    logPath: '/tmp/replay.log',
    sessionStore,
  });

  expect(healed?.positionals[0]).toContain('message_last');
  expect(healed?.positionals[1]).toBe('800');
});

test('replay heal uses canonical iOS snapshot presentation', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-ios-row-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-ios-row-session';
  sessionStore.set(sessionName, makeSession(sessionName));
  const rowRect = { x: 16, y: 293, width: 370, height: 52 };

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      { index: 0, depth: 0, type: 'Application', label: 'Settings' },
      { index: 1, depth: 1, parentIndex: 0, type: 'CollectionView' },
      { index: 2, depth: 2, parentIndex: 1, type: 'Cell', label: 'General', rect: rowRect },
      { index: 3, depth: 3, parentIndex: 2, type: 'Other', label: 'General', rect: rowRect },
      {
        index: 4,
        depth: 4,
        parentIndex: 3,
        type: 'Button',
        label: 'General',
        identifier: 'com.apple.settings.general',
        rect: rowRect,
      },
      { index: 5, depth: 5, parentIndex: 4, type: 'StaticText', label: 'General', rect: rowRect },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const healed = await healReplayAction({
    action: {
      ts: Date.now(),
      command: 'click',
      positionals: ['label="General"'],
      flags: {},
      result: { selectorChain: ['label="General"'] },
    },
    sessionName,
    logPath: '/tmp/replay.log',
    sessionStore,
  });

  expect(healed?.positionals[0]).toContain('com.apple.settings.general');
  expect(sessionStore.get(sessionName)?.snapshot?.nodes.map((node) => node.type)).toEqual([
    'Application',
    'CollectionView',
    'Cell',
  ]);
});

test('replay --update heals selector and rewrites replay file', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-session';
  sessionStore.set(sessionName, makeSession(sessionName));

  writeReplayFile(replayPath, {
    ts: Date.now(),
    command: 'click',
    positionals: ['id="old_continue" || label="Continue"'],
    flags: {},
    result: {},
  });

  const invokeCalls: string[] = [];
  const invoke = async (request: DaemonRequest): Promise<DaemonResponse> => {
    if (request.command !== 'click') {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', message: `unexpected command ${request.command}` },
      };
    }
    const selector = request.positionals?.[0] ?? '';
    invokeCalls.push(selector);
    if (selector.includes('old_continue')) {
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'selector no longer exists' } };
    }
    if (selector.includes('auth_continue')) {
      return { ok: true, data: { clicked: true } };
    }
    return { ok: false, error: { code: 'COMMAND_FAILED', message: 'unexpected selector' } };
  };

  let snapshotDispatchCalls = 0;
  mockDispatchCommand.mockImplementation(
    async (
      _device: DeviceInfo,
      command: string,
      _positionals: string[],
      _out?: string,
      _context?: CommandFlags,
    ): Promise<Record<string, unknown> | void> => {
      if (command !== 'snapshot') {
        throw new Error(`unexpected dispatch command: ${command}`);
      }
      snapshotDispatchCalls += 1;
      return {
        nodes: [
          {
            index: 0,
            type: 'XCUIElementTypeButton',
            label: 'Continue',
            identifier: 'auth_continue',
            rect: { x: 10, y: 10, width: 100, height: 44 },
            enabled: true,
            hittable: true,
          },
        ],
        truncated: false,
        backend: 'xctest',
      };
    },
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: { replayUpdate: true },
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(true);
  if (response!.ok) {
    expect(response!.data?.healed).toBe(1);
    expect(response!.data?.replayed).toBe(1);
  }
  expect(snapshotDispatchCalls).toBe(1);
  expect(invokeCalls.length).toBe(2);
  expect(invokeCalls[0]).toContain('old_continue');
  expect(invokeCalls[1]).toContain('auth_continue');
  const rewrittenSelector = readReplaySelector(replayPath, 'click');
  expect(rewrittenSelector).toContain('auth_continue');
  expect(rewrittenSelector).not.toContain('old_continue');
});

test('replay tolerates legacy snapshot --backend and strips it on rewrite', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-legacy-backend-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'legacy-backend-session';
  sessionStore.set(sessionName, makeSession(sessionName));
  fs.writeFileSync(
    replayPath,
    [
      'snapshot -i --backend xctest',
      'click "id=\\"old_continue\\" || label=\\"Continue\\""',
      '',
    ].join('\n'),
  );

  const invoke = async (request: DaemonRequest): Promise<DaemonResponse> => {
    if (request.command === 'snapshot') {
      return { ok: true, data: { nodes: [] } };
    }
    if (request.command === 'click') {
      const selector = request.positionals?.[0] ?? '';
      if (selector.includes('old_continue')) {
        return {
          ok: false,
          error: { code: 'COMMAND_FAILED', message: 'selector no longer exists' },
        };
      }
      if (selector.includes('auth_continue')) {
        return { ok: true, data: { clicked: true } };
      }
    }
    return {
      ok: false,
      error: { code: 'INVALID_ARGS', message: `unexpected command ${request.command}` },
    };
  };

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 10, width: 100, height: 44 },
        enabled: true,
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: { replayUpdate: true },
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(true);
  const rewritten = fs.readFileSync(replayPath, 'utf8');
  expect(rewritten).toMatch(/^snapshot -i$/m);
  expect(rewritten).not.toMatch(/--backend/);
});

test('replay without --update does not heal or rewrite', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-noheal-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'noheal-session';
  sessionStore.set(sessionName, makeSession(sessionName));

  writeReplayFile(replayPath, {
    ts: Date.now(),
    command: 'click',
    positionals: ['id="old_continue" || label="Continue"'],
    flags: {},
    result: {},
  });
  const originalPayload = fs.readFileSync(replayPath, 'utf8');

  const invoke = async (_request: DaemonRequest): Promise<DaemonResponse> => {
    return {
      ok: false,
      error: {
        code: 'COMMAND_FAILED',
        message: 'selector no longer exists',
        hint: 'update selector',
        diagnosticId: 'diag-replay-1',
        logPath: '/tmp/diag-replay-1.ndjson',
      },
    };
  };

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: {},
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(false);
  if (!response!.ok) {
    expect(response!.error.message).toMatch(/Replay failed at step 1/);
    expect(response!.error.details?.step).toBe(1);
    expect(response!.error.details?.action).toBe('click');
    expect(response!.error.hint).toBe('update selector');
    expect(response!.error.diagnosticId).toBe('diag-replay-1');
    expect(response!.error.logPath).toBe('/tmp/diag-replay-1.ndjson');
  }
  // No --update, so healReplayAction never runs (0 of its own capture calls) —
  // but the divergence report's single shared capture (screen digest +
  // suggestion re-resolution, ADR 0012 migration step 2) still fires
  // unconditionally on failure.
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(replayPath, 'utf8')).toBe(originalPayload);
});

test('replay --update skips malformed selector candidates and preserves replay error context', async () => {
  const tempRoot = fs.mkdtempSync(
    path.join(os.tmpdir(), 'agent-device-replay-malformed-candidate-'),
  );
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'malformed-candidate-session';
  sessionStore.set(sessionName, makeSession(sessionName));

  writeReplayFile(replayPath, {
    ts: Date.now(),
    command: 'click',
    positionals: ['id="old_continue" ||'],
    flags: {},
    result: {},
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: { replayUpdate: true },
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke: async () => ({
      ok: false,
      error: { code: 'COMMAND_FAILED', message: 'selector stale' },
    }),
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(false);
  if (!response!.ok) {
    // ADR 0012 migration step 2: the wire-level code is now REPLAY_DIVERGENCE;
    // the malformed candidate's original COMMAND_FAILED lives in cause.
    expect(response!.error.code).toBe('REPLAY_DIVERGENCE');
    expect(response!.error.message).toMatch(/Replay failed at step 1/);
    expect(response!.error.details?.step).toBe(1);
    expect(response!.error.details?.action).toBe('click');
    const divergence = response!.error.details?.divergence as
      | { cause: { code: string; message: string } }
      | undefined;
    expect(divergence?.cause.code).toBe('COMMAND_FAILED');
    // The malformed selector candidate is still skipped by suggestion
    // ranking (tryParseSelectorChain rejects it), so no suggestion is produced.
    expect((divergence as unknown as { suggestions: unknown[] })?.suggestions).toEqual([]);
  }
  // The divergence report's single shared capture still fires on every
  // failure, even when heal itself would have skipped (malformed candidate) —
  // ADR 0012 migration step 2 behavior, not a heal regression.
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
  expect(fs.readFileSync(replayPath, 'utf8')).toBe('click "id=\\"old_continue\\" ||"\n');
});

test('replay --update heals selector in is command', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-is-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-is-session';
  sessionStore.set(sessionName, makeSession(sessionName));

  writeReplayFile(replayPath, {
    ts: Date.now(),
    command: 'is',
    positionals: ['visible', 'id="old_continue" || label="Continue"'],
    flags: {},
    result: {},
  });

  const invoke = async (request: DaemonRequest): Promise<DaemonResponse> => {
    if (request.command !== 'is') {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', message: `unexpected command ${request.command}` },
      };
    }
    const selector = request.positionals?.[1] ?? '';
    if (selector.includes('old_continue')) {
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'selector stale' } };
    }
    if (selector.includes('auth_continue')) {
      return { ok: true, data: { predicate: 'visible', pass: true } };
    }
    return { ok: false, error: { code: 'COMMAND_FAILED', message: 'unexpected selector' } };
  };

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 10, width: 100, height: 44 },
        enabled: true,
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: { replayUpdate: true },
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(true);
  if (response!.ok) {
    expect(response!.data?.healed).toBe(1);
  }
  const rewrittenSelector = readReplaySelector(replayPath, 'is');
  expect(rewrittenSelector).toContain('auth_continue');
});

test('replay --update does not heal clicks from stored ref labels alone', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-ref-label-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-ref-label-session';
  sessionStore.set(sessionName, makeSession(sessionName));

  // @refs are never selector candidates; this guards against reintroducing
  // fallback healing from the stored replay label.
  fs.writeFileSync(replayPath, 'click @e1 "Continue"\n');
  const originalPayload = fs.readFileSync(replayPath, 'utf8');

  const invokeCalls: string[] = [];
  const invoke = async (request: DaemonRequest): Promise<DaemonResponse> => {
    if (request.command !== 'click') {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', message: `unexpected command ${request.command}` },
      };
    }
    const target = request.positionals?.[0] ?? '';
    invokeCalls.push(target);
    return { ok: false, error: { code: 'COMMAND_FAILED', message: 'missing ref target' } };
  };

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 10, width: 100, height: 44 },
        enabled: true,
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: { replayUpdate: true },
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(false);
  if (!response!.ok) {
    expect(response!.error.message).toMatch(/Replay failed at step 1/);
    expect(response!.error.details?.step).toBe(1);
    expect(response!.error.details?.action).toBe('click');
    const divergence = response!.error.details?.divergence as
      | { suggestions: unknown[] }
      | undefined;
    // @refs are never selector candidates, so no suggestion is produced —
    // same non-healing guarantee this test title asserts, now for suggestions.
    expect(divergence?.suggestions).toEqual([]);
  }
  // The divergence report's single shared capture still fires on every
  // failure (ADR 0012 migration step 2) even though no suggestion candidate
  // exists for an @ref-targeted action.
  expect(mockDispatchCommand).toHaveBeenCalledTimes(1);
  expect(invokeCalls).toEqual(['@e1']);
  expect(fs.readFileSync(replayPath, 'utf8')).toBe(originalPayload);
});

test('replay --update does not heal numeric get text drift from snapshot text alone', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-get-numeric-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-get-numeric-session';
  sessionStore.set(sessionName, makeSession(sessionName));

  writeReplayFile(replayPath, {
    ts: Date.now(),
    command: 'get',
    positionals: ['text', 'role="statictext" label="2" || label="2"'],
    flags: {},
    result: {},
  });
  const originalPayload = fs.readFileSync(replayPath, 'utf8');

  const invokeCalls: string[] = [];
  const invoke = async (request: DaemonRequest): Promise<DaemonResponse> => {
    if (request.command !== 'get') {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', message: `unexpected command ${request.command}` },
      };
    }
    const selector = request.positionals?.[1] ?? '';
    invokeCalls.push(selector);
    return { ok: false, error: { code: 'COMMAND_FAILED', message: 'selector stale' } };
  };

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'XCUIElementTypeStaticText',
        label: '20',
        rect: { x: 0, y: 100, width: 100, height: 24 },
        enabled: true,
        hittable: true,
      },
      {
        index: 1,
        type: 'XCUIElementTypeStaticText',
        label: 'Version: 0.84.0',
        rect: { x: 0, y: 200, width: 220, height: 17 },
        enabled: true,
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: { replayUpdate: true },
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(false);
  if (!response!.ok) {
    expect(response!.error.message).toMatch(/Replay failed at step 1/);
    expect(response!.error.details?.step).toBe(1);
    expect(response!.error.details?.action).toBe('get');
    const divergence = response!.error.details?.divergence as
      | { suggestions: unknown[] }
      | undefined;
    // Same non-healing guarantee as heal itself: a numeric label drift is not
    // isolated by re-resolving the recorded selector, so no suggestion either.
    expect(divergence?.suggestions).toEqual([]);
  }
  // 1 capture from healReplayAction's own (unsuccessful) attempt, plus the
  // divergence report's single shared capture (ADR 0012 migration step 2)
  // once heal gives up and the step fails.
  expect(mockDispatchCommand).toHaveBeenCalledTimes(2);
  expect(invokeCalls.length).toBe(1);
  expect(fs.readFileSync(replayPath, 'utf8')).toBe(originalPayload);
});

test('replay --update heals selector in press command and preserves press series flags', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-heal-press-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'heal-press-session';
  sessionStore.set(sessionName, makeSession(sessionName));
  fs.writeFileSync(
    replayPath,
    'press "id=\\"old_continue\\" || label=\\"Continue\\"" --count 3 --interval-ms 1 --double-tap\n',
  );

  const invokeCalls: DaemonRequest[] = [];
  const invoke = async (request: DaemonRequest): Promise<DaemonResponse> => {
    if (request.command !== 'press') {
      return {
        ok: false,
        error: { code: 'INVALID_ARGS', message: `unexpected command ${request.command}` },
      };
    }
    invokeCalls.push(request);
    const selector = request.positionals?.[0] ?? '';
    if (selector.includes('old_continue')) {
      return { ok: false, error: { code: 'COMMAND_FAILED', message: 'selector no longer exists' } };
    }
    if (selector.includes('auth_continue')) {
      return { ok: true, data: { pressed: true } };
    }
    return { ok: false, error: { code: 'COMMAND_FAILED', message: 'unexpected selector' } };
  };

  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'XCUIElementTypeButton',
        label: 'Continue',
        identifier: 'auth_continue',
        rect: { x: 10, y: 10, width: 100, height: 44 },
        enabled: true,
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'xctest',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: { replayUpdate: true },
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(true);
  if (response!.ok) {
    expect(response!.data?.healed).toBe(1);
    expect(response!.data?.replayed).toBe(1);
  }
  expect(invokeCalls.length).toBe(2);
  expect(invokeCalls[0]?.flags?.count).toBe(3);
  expect(invokeCalls[0]?.flags?.intervalMs).toBe(1);
  expect(invokeCalls[0]?.flags?.doubleTap).toBe(true);
  const updatedLine = fs
    .readFileSync(replayPath, 'utf8')
    .split(/\r?\n/)
    .find((line) => line.startsWith('press '));
  expect(updatedLine).toBeTruthy();
  const tokens = tokenizeReplayLine(updatedLine!);
  expect(tokens[1]).toContain('auth_continue');
  expect(tokens.slice(2)).toEqual(['--count', '3', '--interval-ms', '1', '--double-tap']);
});

test('replay rejects legacy JSON payload files', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-json-rejected-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.json');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'json-rejected-session';
  sessionStore.set(sessionName, makeSession(sessionName));
  fs.writeFileSync(replayPath, JSON.stringify({ optimizedActions: [] }, null, 2));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: {},
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(false);
  if (!response!.ok) {
    expect(response!.error.code).toBe('INVALID_ARGS');
    expect(response!.error.message).toMatch(/\.ad script files/);
  }
});

test('replay rejects malformed .ad lines with unclosed quotes', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-invalid-ad-'));
  const sessionsDir = path.join(tempRoot, 'sessions');
  const replayPath = path.join(tempRoot, 'replay.ad');
  const sessionStore = new SessionStore(sessionsDir);
  const sessionName = 'invalid-ad-session';
  sessionStore.set(sessionName, makeSession(sessionName));
  fs.writeFileSync(replayPath, 'click "id=\\"broken\\"\n');

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'replay',
      positionals: [replayPath],
      flags: {},
    },
    sessionName,
    logPath: path.join(tempRoot, 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response).toBeTruthy();
  expect(response!.ok).toBe(false);
  if (!response!.ok) {
    expect(response!.error.code).toBe('INVALID_ARGS');
    expect(response!.error.message).toMatch(/Invalid replay script line/);
  }
});
