import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../__tests__/test-utils/tmp-dir.ts';

const processState = vi.hoisted(() => ({
  alive: new Set<number>(),
  starts: new Map<number, string>(),
  commands: new Map<number, string>(),
  waitExits: true,
}));

vi.mock('./host-process.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./host-process.ts')>()),
  isProcessAlive: (pid: number) => processState.alive.has(pid),
  isProcessZombie: () => false,
  readProcessStartTime: (pid: number) => processState.starts.get(pid) ?? null,
  readProcessCommand: (pid: number) => processState.commands.get(pid) ?? null,
  waitForProcessExit: async (pid: number) => {
    if (processState.waitExits) processState.alive.delete(pid);
    return true;
  },
}));

import { createOwnedProcessRecordStore } from './owned-process-record.ts';
import { reapOwnedProcessRecordsAtStartup } from './owned-process-reaper.ts';

beforeEach(() => {
  processState.alive.clear();
  processState.starts.clear();
  processState.commands.clear();
  processState.waitExits = true;
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('publishes root and session records and removes an empty record atomically', () => {
  const stateDir = mkdtempForTestSync('agent-device-owned-process-record-');
  const sessionsDir = path.join(stateDir, 'sessions');
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir,
    resolveSessionDir: (sessionId) => path.join(sessionsDir, sessionId),
  });
  const record = { pid: 42, startTime: 'start', command: 'command', purpose: 'test-process' };

  try {
    store.replace({ kind: 'daemon' }, [record]);
    store.replace({ kind: 'session', sessionId: 'one' }, [record]);

    assert.deepEqual(
      store.read().map(({ scope, records }) => ({ scope, records })),
      [
        { scope: { kind: 'daemon' }, records: [record] },
        { scope: { kind: 'session', sessionId: 'one' }, records: [record] },
      ],
    );
    assert.equal(fs.existsSync(path.join(stateDir, 'owned-processes.json')), true);
    assert.equal(fs.existsSync(path.join(sessionsDir, 'one', 'owned-processes.json')), true);

    store.replace({ kind: 'daemon' }, []);
    assert.equal(fs.existsSync(path.join(stateDir, 'owned-processes.json')), false);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('rejects a session record path outside the configured sessions directory', () => {
  const stateDir = mkdtempForTestSync('agent-device-owned-process-record-path-');
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionDir: () => path.join(stateDir, 'outside-session'),
  });

  try {
    assert.throws(
      () =>
        store.replace({ kind: 'session', sessionId: 'escape' }, [
          { pid: 42, startTime: 'start', command: 'command', purpose: 'test-process' },
        ]),
      /directly under the sessions dir/,
    );
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('startup reaps an exact identity and clears the record', async () => {
  const stateDir = mkdtempForTestSync('agent-device-owned-process-reap-');
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionDir: (sessionId) => path.join(stateDir, 'sessions', sessionId),
  });
  const record = {
    pid: 101,
    startTime: 'start-101',
    command: 'command-101',
    purpose: 'managed-web-browser',
  };
  processState.alive.add(record.pid);
  processState.starts.set(record.pid, record.startTime);
  processState.commands.set(record.pid, record.command);
  const signals: Array<string | number | undefined> = [];
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    signals.push(signal);
    return true;
  });

  try {
    store.replace({ kind: 'daemon' }, [record]);

    await assert.doesNotReject(
      reapOwnedProcessRecordsAtStartup(store, { termTimeoutMs: 1, killTimeoutMs: 1 }),
    );
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(store.read().length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('startup interrupts an exact simctl recorder before clearing its record', async () => {
  const stateDir = mkdtempForTestSync('agent-device-owned-process-simctl-reap-');
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionDir: (sessionId) => path.join(stateDir, 'sessions', sessionId),
  });
  const record = {
    pid: 111,
    startTime: 'start-111',
    command: 'xcrun simctl io simulator recordVideo /tmp/recording.mp4',
    purpose: 'simctl-screen-recording',
  };
  processState.alive.add(record.pid);
  processState.starts.set(record.pid, record.startTime);
  processState.commands.set(record.pid, record.command);
  const signals: Array<string | number | undefined> = [];
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    signals.push(signal);
    return true;
  });

  try {
    store.replace({ kind: 'session', sessionId: 'record' }, [record]);

    await reapOwnedProcessRecordsAtStartup(store, { termTimeoutMs: 1, killTimeoutMs: 1 });

    assert.deepEqual(signals, ['SIGINT']);
    assert.equal(store.read().length, 0);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('startup retains a record when the pid identity was reused', async () => {
  const stateDir = mkdtempForTestSync('agent-device-owned-process-reuse-');
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionDir: (sessionId) => path.join(stateDir, 'sessions', sessionId),
  });
  const record = {
    pid: 202,
    startTime: 'old-start',
    command: 'old-command',
    purpose: 'managed-web-browser',
  };
  processState.alive.add(record.pid);
  processState.starts.set(record.pid, 'new-start');
  processState.commands.set(record.pid, 'new-command');
  const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

  try {
    store.replace({ kind: 'daemon' }, [record]);

    const summary = await reapOwnedProcessRecordsAtStartup(store);

    assert.deepEqual(summary.ownershipLostPids, [record.pid]);
    assert.equal(killSpy.mock.calls.length, 0);
    assert.equal(store.read().length, 1);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});

test('startup does not force-kill a live process after its identity changes', async () => {
  const stateDir = mkdtempForTestSync('agent-device-owned-process-replaced-');
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionDir: (sessionId) => path.join(stateDir, 'sessions', sessionId),
  });
  const record = {
    pid: 303,
    startTime: 'start-303',
    command: 'old-command',
    purpose: 'managed-web-browser',
  };
  processState.alive.add(record.pid);
  processState.starts.set(record.pid, record.startTime);
  processState.commands.set(record.pid, record.command);
  processState.waitExits = false;
  const signals: Array<string | number | undefined> = [];
  vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    signals.push(signal);
    processState.commands.set(record.pid, 'new-command');
    return true;
  });

  try {
    store.replace({ kind: 'daemon' }, [record]);

    const summary = await reapOwnedProcessRecordsAtStartup(store, {
      termTimeoutMs: 1,
      killTimeoutMs: 1,
    });

    assert.deepEqual(summary.ownershipLostPids, [record.pid]);
    assert.deepEqual(signals, ['SIGTERM']);
    assert.equal(store.read().length, 1);
  } finally {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
});
