import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
const processProbe = vi.hoisted(() => ({ startTimeUnreadable: false }));
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    readProcessStartTime: (pid: number) =>
      processProbe.startTimeUnreadable ? null : actual.readProcessStartTime(pid),
  };
});

import { readCurrentOwnerIdentity } from '@agent-device/host-kit/process';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from './daemon-resolution.ts';
import { readDaemonStatus } from './daemon-registration.ts';

const FAILED = {
  provider: 'broken',
  source: 'store',
  package: '@example/broken',
  version: '1.0.0',
  state: 'failed',
  error: {
    code: 'INVALID_ARGS',
    message: 'Plugin must export a default factory',
    reason: 'invalid_plugin',
  },
  credentials: { variables: [], byBackend: {} },
};
const ACTIVE = {
  provider: 'browserstack',
  source: 'builtin',
  state: 'active',
  credentials: { variables: ['BROWSERSTACK_USERNAME'], byBackend: { 'ios-instance': ['A'] } },
};

function publish(stateDir: string, record: Record<string, unknown>): void {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'daemon.json'), JSON.stringify(record));
}

test('a state dir without a daemon record reports no running daemon', () => {
  const paths = resolveDaemonPaths(mkdtempForTestSync('agent-device-daemon-status-'));
  expect(readDaemonStatus(paths)).toEqual({
    state: 'stopped',
    stateDir: paths.baseDir,
  });
});

test('a live registered daemon reports its identity and the plugin inventory it published', () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-status-');
  const owner = readCurrentOwnerIdentity();
  publish(stateDir, {
    token: 't',
    port: 1,
    pid: owner.pid,
    processStartTime: owner.startTime,
    version: '0.21.30',
    transport: 'http',
    plugins: [ACTIVE, FAILED, { state: 'unknown' }],
  });

  expect(readDaemonStatus(resolveDaemonPaths(stateDir))).toEqual({
    state: 'running',
    stateDir,
    pid: owner.pid,
    // A record that predates ownership is a detached daemon, which is what a reader must be able to
    // rely on before it decides a stop may signal this pid.
    ownership: 'detached',
    version: '0.21.30',
    transport: 'http',
    plugins: [ACTIVE, FAILED, { state: 'unknown' }],
  });
});

test('a record published by a host reports the ownership that limits what a stop may do', () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-status-');
  const owner = readCurrentOwnerIdentity();
  publish(stateDir, {
    token: 't',
    port: 1,
    pid: owner.pid,
    processStartTime: owner.startTime,
    ownership: 'embedded',
  });

  expect(readDaemonStatus(resolveDaemonPaths(stateDir))).toMatchObject({
    state: 'running',
    pid: owner.pid,
    ownership: 'embedded',
  });
});

test('a record that claims an ownership nobody knows reads as an unrecognized one', () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-status-');
  const owner = readCurrentOwnerIdentity();
  publish(stateDir, {
    token: 't',
    port: 1,
    pid: owner.pid,
    processStartTime: owner.startTime,
    ownership: 'sideways',
  });

  // An ownership value outside the vocabulary says nothing about who owns the process, and `detached`
  // is the one reading a caller may act on by signalling it. Status says it cannot recognize the owner.
  expect(readDaemonStatus(resolveDaemonPaths(stateDir)).ownership).toBe('unknown');
});

test('a record whose process is gone or was replaced is not a running daemon', () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-status-');
  const owner = readCurrentOwnerIdentity();
  publish(stateDir, {
    token: 't',
    port: 1,
    pid: owner.pid,
    processStartTime: 'Thu Jan  1 00:00:00 1970',
    plugins: [ACTIVE],
  });
  expect(readDaemonStatus(resolveDaemonPaths(stateDir)).state).toBe('stopped');
  publish(stateDir, {
    token: 't',
    port: 1,
    pid: 2_147_483_000,
    processStartTime: owner.startTime,
    plugins: [ACTIVE],
  });
  expect(readDaemonStatus(resolveDaemonPaths(stateDir))).toMatchObject({
    state: 'stopped',
  });
});

test('a live process whose start time cannot be read still counts as the running daemon', () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-status-');
  const owner = readCurrentOwnerIdentity();
  publish(stateDir, {
    token: 't',
    port: 1,
    pid: owner.pid,
    processStartTime: owner.startTime,
    plugins: [ACTIVE],
  });
  processProbe.startTimeUnreadable = true;
  try {
    expect(readDaemonStatus(resolveDaemonPaths(stateDir))).toMatchObject({
      state: 'running',
      plugins: [ACTIVE],
    });
  } finally {
    processProbe.startTimeUnreadable = false;
  }
});

test('text that is not a daemon record is invalid, not a stopped daemon', () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-status-');
  for (const text of ['{ not json', '[]', 'null']) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'daemon.json'), text);
    expect(readDaemonStatus(resolveDaemonPaths(stateDir))).toEqual({ state: 'invalid', stateDir });
  }
});

test('a record that exists but cannot be read is unreadable, not a stopped daemon', () => {
  const stateDir = mkdtempForTestSync('agent-device-daemon-status-');
  publish(stateDir, { token: 't', port: 1, pid: 1, processStartTime: 'x' });
  const infoPath = path.join(stateDir, 'daemon.json');
  fs.chmodSync(infoPath, 0o000);
  try {
    if (process.getuid?.() === 0) return;
    expect(readDaemonStatus(resolveDaemonPaths(stateDir))).toEqual({
      state: 'unreadable',
      stateDir,
    });
  } finally {
    fs.chmodSync(infoPath, 0o600);
  }
});
