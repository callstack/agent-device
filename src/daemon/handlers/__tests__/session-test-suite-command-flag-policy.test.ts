/**
 * The raw-wire flag policy `test` enforces before a suite runs: replay-only flags must be refused
 * at the daemon boundary, not silently fanned into every attempt. Moved here with the command
 * itself when the test-suite command left `session-replay.ts` (AGENTS.md, tests mirror source
 * topology).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { handleSessionReplayCommands } from '../session-replay.ts';
import { REPLAY_ONLY_TEST_FLAG_REJECTIONS } from '../session-replay-test-policy.ts';
import { replayCommandFamily } from '../../../commands/replay/index.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';

// --- ADR 0012 decision 4 / migration step 5: `--from` is replay-only ---

test('raw test-request guards enumerate every daemon-visible replay-only CLI flag', () => {
  const replayFlags = replayCommandFamily.cliSchemas.replay?.allowedFlags ?? [];
  const testFlags = new Set(replayCommandFamily.cliSchemas.test?.allowedFlags ?? []);
  const clientOnlyReplayFlags = new Set(['out']);
  const expectedDaemonFlags = replayFlags
    .filter((flag) => !testFlags.has(flag) && !clientOnlyReplayFlags.has(flag))
    .sort();

  const guardedDaemonFlags = REPLAY_ONLY_TEST_FLAG_REJECTIONS.flatMap(
    (rejection) => rejection.keys,
  ).sort();
  assert.deepEqual(guardedDaemonFlags, expectedDaemonFlags);
});

test('test rejects raw --keep-session with INVALID_ARGS before running the suite', async () => {
  const root = mkdtempForTestSync('agent-device-test-keep-session-rejected-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  const response = await handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { replayKeepSession: true },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformResourceCleanup,
    invoke,
  });

  if (!response) throw new Error('Expected response');
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.match(response.error.message, /--keep-session/);
  assert.equal(invoke.mock.calls.length, 0);
});

test('test rejects --from with INVALID_ARGS before running the suite', async () => {
  const root = mkdtempForTestSync('agent-device-test-from-rejected-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\nclick "Continue"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));

  const response = await handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { replayFrom: 2, replayPlanDigest: 'deadbeef' },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformResourceCleanup,
    invoke: async () => {
      throw new Error('test must not start executing when --from is rejected');
    },
  });

  if (!response) throw new Error('Expected response');
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.match(response.error.message, /--from/);
});

test('test rejects --plan-digest alone with INVALID_ARGS before running the suite', async () => {
  const root = mkdtempForTestSync('agent-device-test-digest-rejected-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\nclick "Continue"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));

  const response = await handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { replayPlanDigest: 'deadbeef' },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformResourceCleanup,
    invoke: async () => {
      throw new Error('test must not start executing when --plan-digest is rejected');
    },
  });

  if (!response) throw new Error('Expected response');
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
});

// --- ADR 0012 decision 6: `--save-script` is replay-only ---

test('test rejects --save-script with INVALID_ARGS before running the suite', async () => {
  const root = mkdtempForTestSync('agent-device-test-savescript-rejected-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\nclick "Continue"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));

  const response = await handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { saveScript: true },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformResourceCleanup,
    invoke: async () => {
      throw new Error('test must not start executing when --save-script is rejected');
    },
  });

  if (!response) throw new Error('Expected response');
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.match(response.error.message, /--save-script/);
});

test('test rejects raw --force without --save-script before running the suite', async () => {
  const root = mkdtempForTestSync('agent-device-test-force-rejected-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  const response = await handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { force: true },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    platformResourceCleanup,
    invoke,
  });

  if (!response) throw new Error('Expected response');
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.match(response.error.message, /--force/);
  assert.equal(invoke.mock.calls.length, 0);
});
