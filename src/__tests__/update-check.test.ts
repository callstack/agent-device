import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

vi.mock('@agent-device/host-kit/command', () => ({
  runCmdDetached: vi.fn(),
}));

import { runCmdDetached } from '@agent-device/host-kit/command';
import { maybeRunUpgradeNotifier, runUpdateCheckWorker } from '../cli/update-check.ts';

function makeTempStateDir(): string {
  return mkdtempForTestSync('agent-device-update-check-');
}

function writeCache(stateDir: string, payload: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(stateDir, 'update-check.json'),
    `${JSON.stringify(payload, null, 2)}\n`,
  );
}

function readCache(stateDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(stateDir, 'update-check.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

const cleanupPaths: string[] = [];
const originalStderrIsTTY = process.stderr.isTTY;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-03-31T10:00:00.000Z'));
  vi.stubEnv('NODE_ENV', '');
  vi.stubEnv('CI', '');
  vi.stubEnv('AGENT_DEVICE_NO_UPDATE_NOTIFIER', '');
  Object.defineProperty(process.stderr, 'isTTY', {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  Object.defineProperty(process.stderr, 'isTTY', {
    configurable: true,
    value: originalStderrIsTTY,
  });
  while (cleanupPaths.length > 0) {
    const next = cleanupPaths.pop();
    if (next) {
      fs.rmSync(next, { recursive: true, force: true });
    }
  }
});

test('notifier prints cached upgrade notice once for a newly discovered version', () => {
  const stateDir = makeTempStateDir();
  cleanupPaths.push(stateDir);
  writeCache(stateDir, {
    latestVersion: '0.12.0',
    checkedAt: '2026-03-25T10:00:00.000Z',
  });

  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);

  maybeRunUpgradeNotifier({
    command: 'devices',
    currentVersion: '0.11.3',
    stateDir,
    flags: {},
  });

  assert.match(stderr, /Update available: agent-device 0\.11\.3 -> 0\.12\.0/);
  assert.equal(vi.mocked(runCmdDetached).mock.calls.length, 0);
  const cache = readCache(stateDir);
  assert.equal(cache.prompted, true);
});

test('notifier skips repeat prompts after the cached version was already shown', () => {
  const stateDir = makeTempStateDir();
  cleanupPaths.push(stateDir);
  writeCache(stateDir, {
    latestVersion: '0.12.0',
    checkedAt: '2026-03-25T10:00:00.000Z',
    prompted: true,
  });

  let stderr = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);

  maybeRunUpgradeNotifier({
    command: 'devices',
    currentVersion: '0.11.3',
    stateDir,
    flags: {},
  });

  assert.equal(stderr, '');
});

test('notifier starts a background check when the cache is stale', () => {
  const stateDir = makeTempStateDir();
  cleanupPaths.push(stateDir);
  writeCache(stateDir, {
    checkedAt: '2026-03-01T10:00:00.000Z',
  });

  maybeRunUpgradeNotifier({
    command: 'devices',
    currentVersion: '0.11.3',
    stateDir,
    flags: {},
  });

  const spawnCall = vi.mocked(runCmdDetached).mock.calls[0];
  assert.ok(spawnCall);
  assert.equal(spawnCall[0], process.execPath);
  assert.equal(spawnCall[1][0], '--experimental-strip-types');
  assert.match(spawnCall[1][1] ?? '', /\/src\/cli\/update-check-entry\.ts$/);
  assert.equal(spawnCall[1][2], '--agent-device-run-update-check');
  assert.equal(spawnCall[1][3], path.join(stateDir, 'update-check.json'));
  assert.equal(spawnCall[1][4], '0.11.3');
});

test('worker resets prompted state when it discovers a newer version', async () => {
  const stateDir = makeTempStateDir();
  cleanupPaths.push(stateDir);
  const cachePath = path.join(stateDir, 'update-check.json');
  writeCache(stateDir, {
    latestVersion: '0.12.0',
    checkedAt: '2026-03-15T10:00:00.000Z',
    prompted: true,
  });

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: '0.13.0' }),
    }),
  );

  await runUpdateCheckWorker({
    cachePath,
    currentVersion: '0.11.3',
  });

  const cache = readCache(stateDir);
  assert.equal(cache.latestVersion, '0.13.0');
  assert.equal(cache.prompted, false);
});
