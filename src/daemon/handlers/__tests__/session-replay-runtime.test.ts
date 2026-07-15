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

test('Maestro YAML uses the typed engine while .ad remains generic', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-typed-maestro-route-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const yamlPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(
    yamlPath,
    ['appId: com.example.app', '---', '- launchApp', '- inputText: typed'].join('\n'),
  );
  const commands: string[] = [];
  const invoke = vi.fn(async (request) => {
    if (request.command === 'snapshot') {
      return { ok: true as const, data: { createdAt: 0, nodes: [] } };
    }
    commands.push(request.command);
    return { ok: true as const, data: {} };
  });

  const yamlResponse = await runReplayScriptFile({
    req: baseReq({
      positionals: [yamlPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(yamlResponse).toMatchObject({ ok: true, data: { replayed: 2 } });
  expect(commands).toEqual(['open', 'type']);

  commands.length = 0;
  const adPath = writeReplayFile(root, ['open "Generic"']);
  const adResponse = await runReplayScriptFile({
    req: baseReq({
      positionals: [adPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });
  expect(adResponse).toMatchObject({ ok: true, data: { replayed: 1 } });
  expect(commands).toEqual(['open']);
});

test('typed Maestro nested commands receive the runtime hints bound into the plan', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-runtime-envelope-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const session = makeIosSession(sessionName);
  sessionStore.set(sessionName, {
    ...session,
    device: { ...session.device, simulatorSetPath: '/tmp/custom-simulator-set' },
  });
  sessionStore.setRuntimeHints(sessionName, {
    platform: 'ios',
    metroHost: '127.0.0.1',
    metroPort: 8083,
  });
  const yamlPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(yamlPath, 'appId: com.example.app\n---\n- launchApp\n');
  const requests: Parameters<Parameters<typeof runReplayScriptFile>[0]['invoke']>[0][] = [];

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [yamlPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke: async (request) => {
      requests.push(request);
      return { ok: true, data: {} };
    },
  });

  expect(response.ok).toBe(true);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    command: 'open',
    flags: {
      platform: 'ios',
      udid: 'sim-1',
      iosSimulatorDeviceSet: '/tmp/custom-simulator-set',
      noRecord: true,
    },
    runtime: {
      platform: 'ios',
      metroHost: '127.0.0.1',
      metroPort: 8083,
    },
  });
});

test('typed Maestro writes source-aware redacted step timing traces', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-maestro-step-trace-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const yamlPath = path.join(root, 'flow.yaml');
  const tracePath = path.join(root, 'replay-timing.ndjson');
  fs.writeFileSync(yamlPath, 'appId: com.example.app\n---\n- inputText: highly-sensitive\n');
  fs.writeFileSync(tracePath, '');

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [yamlPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    tracePath,
    invoke: async (request) =>
      request.command === 'snapshot'
        ? { ok: true, data: { createdAt: 0, nodes: [] } }
        : { ok: true, data: {} },
  });

  expect(response.ok).toBe(true);
  const events = fs
    .readFileSync(tracePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(events).toEqual([
    expect.objectContaining({
      type: 'replay_action_start',
      replayPath: yamlPath,
      line: 3,
      step: 1,
      command: 'inputText',
      positionals: ['<text>'],
    }),
    expect.objectContaining({
      type: 'replay_action_stop',
      replayPath: yamlPath,
      line: 3,
      step: 1,
      command: 'inputText',
      ok: true,
      durationMs: expect.any(Number),
      resultTiming: { hierarchyCaptures: 2, screenshotCaptures: 0, tapRetries: 0 },
    }),
  ]);
  expect(fs.readFileSync(tracePath, 'utf8')).not.toContain('highly-sensitive');
});

test('replay trace failures do not change action semantics', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-trace-failure-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const yamlPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(yamlPath, 'appId: com.example.app\n---\n- back\n');

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [yamlPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    tracePath: root,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(true);
});

test('generic replay traces redact typed text', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-trace-redaction-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const secret = 'highly-sensitive-value';
  const filePath = writeReplayFile(root, [`type "${secret}"`]);
  const tracePath = path.join(root, 'replay-timing.ndjson');
  fs.writeFileSync(tracePath, '');

  const response = await runReplayScriptFile({
    req: baseReq({ positionals: [filePath] }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    tracePath,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response.ok).toBe(true);
  const trace = fs.readFileSync(tracePath, 'utf8');
  expect(trace).not.toContain(secret);
  expect(trace).toContain('<text:22 chars>');
});

test('Maestro YAML rejects .ad repair recording before executing any command', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-typed-maestro-save-script-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName));
  const yamlPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(yamlPath, 'appId: com.example.app\n---\n- launchApp\n');
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [yamlPath],
      flags: { replayBackend: 'maestro', platform: 'ios', saveScript: true },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/Maestro YAML.*--save-script.*\.ad scripts/);
  expect(invoke).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)?.recordSession).not.toBe(true);
});

test('Maestro YAML cannot append commands to an active .ad repair session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-typed-maestro-active-repair-'));
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  const session = makeIosSession(sessionName);
  session.recordSession = true;
  session.saveScriptBoundary = 0;
  sessionStore.set(sessionName, session);
  const yamlPath = path.join(root, 'flow.yaml');
  fs.writeFileSync(yamlPath, 'appId: com.example.app\n---\n- launchApp\n');
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  const response = await runReplayScriptFile({
    req: baseReq({
      positionals: [yamlPath],
      flags: { replayBackend: 'maestro', platform: 'ios' },
    }),
    sessionName,
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    invoke,
  });

  expect(response.ok).toBe(false);
  if (response.ok) return;
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/active \.ad --save-script repair run/);
  expect(invoke).not.toHaveBeenCalled();
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
