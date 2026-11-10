import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from './tmp-dir.fixtures.ts';

// The reaper stops through the shared escalation, so the double answers the two host syscalls it
// reads: `kill(pid, signal)` for signals and liveness, and `ps` for the recorded identity.
const processState = vi.hoisted(() => ({
  alive: new Set<number>(),
  starts: new Map<number, string>(),
  commands: new Map<number, string>(),
  zombiePids: new Set<number>(),
  /** Whether a signaled process exits; `false` keeps it running through every stage. */
  exitsOnSignal: true,
  /** The command a signaled process shows afterwards, as after an `exec`. */
  commandAfterSignal: undefined as string | undefined,
  /** The start time a signaled pid shows afterwards, as when the pid is handed to a new process. */
  startAfterSignal: undefined as string | undefined,
  signals: [] as Array<string | number | undefined>,
  mockRunCmd: vi.fn(),
}));

vi.mock('./exec.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./exec.ts')>()),
  runCmd: processState.mockRunCmd,
}));

function driveHost(): void {
  vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal: string | number) => {
    if (signal === 0) {
      if (processState.alive.has(pid)) return true;
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' });
    }
    processState.signals.push(signal);
    if (processState.commandAfterSignal)
      processState.commands.set(pid, processState.commandAfterSignal);
    if (processState.startAfterSignal) processState.starts.set(pid, processState.startAfterSignal);
    if (processState.exitsOnSignal) processState.alive.delete(pid);
    return true;
  }) as typeof process.kill);
  processState.mockRunCmd.mockImplementation(async (_cmd: string, args: readonly string[]) => {
    const pid = Number(args[1]);
    if (!processState.alive.has(pid)) return { stdout: '', stderr: '', exitCode: 1 };
    if (args[3] === 'pid=,command=') {
      const command = processState.commands.get(pid);
      return { stdout: command ? `${pid} ${command}\n` : '', stderr: '', exitCode: 0 };
    }
    const state = processState.zombiePids.has(pid) ? 'Z' : 'S';
    return { stdout: `${pid} ${state} ${processState.starts.get(pid)}\n`, stderr: '', exitCode: 0 };
  });
}

import { createOwnedProcessRecordStore } from './owned-process-record.ts';
import { reapOwnedProcessRecordsAtStartup } from './owned-process-reaper.ts';

beforeEach(() => {
  processState.alive.clear();
  processState.starts.clear();
  processState.commands.clear();
  processState.zombiePids.clear();
  processState.exitsOnSignal = true;
  processState.commandAfterSignal = undefined;
  processState.startAfterSignal = undefined;
  processState.signals = [];
  processState.mockRunCmd.mockReset();
  driveHost();
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

function reapFixture(name: string) {
  const stateDir = mkdtempForTestSync(`agent-device-owned-process-${name}-`);
  const store = createOwnedProcessRecordStore({
    stateDir,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionDir: (sessionId) => path.join(stateDir, 'sessions', sessionId),
  });
  return { store, cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }) };
}

function hostRuns(record: { pid: number; startTime: string; command: string }): void {
  processState.alive.add(record.pid);
  processState.starts.set(record.pid, record.startTime);
  processState.commands.set(record.pid, record.command);
}

const BROWSER = {
  pid: 101,
  startTime: 'Mon Nov  9 10:00:00 2026',
  command: '/opt/chrome --user-data-dir=/tmp/agent-device-browser',
  purpose: 'managed-web-browser',
};

test('startup reaps an exact identity and clears the record', async () => {
  const { store, cleanup } = reapFixture('reap');
  hostRuns(BROWSER);
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store, {
      termTimeoutMs: 1,
      killTimeoutMs: 1,
    });

    assert.deepEqual(summary.terminatedPids, [BROWSER.pid]);
    assert.deepEqual(processState.signals, ['SIGTERM']);
    assert.equal(store.read().length, 0);
  } finally {
    cleanup();
  }
});

test('startup interrupts an exact simctl recorder before clearing its record', async () => {
  const { store, cleanup } = reapFixture('simctl-reap');
  const record = {
    pid: 111,
    startTime: 'Mon Nov  9 10:00:00 2026',
    command: 'xcrun simctl io simulator recordVideo /tmp/recording.mp4',
    purpose: 'simctl-screen-recording',
  };
  hostRuns(record);
  try {
    store.replace({ kind: 'session', sessionId: 'record' }, [record]);

    await reapOwnedProcessRecordsAtStartup(store, { termTimeoutMs: 1, killTimeoutMs: 1 });

    assert.deepEqual(processState.signals, ['SIGINT']);
    assert.equal(store.read().length, 0);
  } finally {
    cleanup();
  }
});

test('startup treats a zombie identity as missing without signaling it', async () => {
  // A zombie has already terminated: it is cleaned as missing, never signaled.
  const { store, cleanup } = reapFixture('zombie-reap');
  hostRuns(BROWSER);
  processState.zombiePids.add(BROWSER.pid);
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store);

    assert.deepEqual(summary.missingPids, [BROWSER.pid]);
    assert.deepEqual(processState.signals, []);
    assert.equal(store.read().length, 0);
  } finally {
    cleanup();
  }
});

test('startup forgets a record whose pid the host shows in another lifetime, without signaling it', async () => {
  const { store, cleanup } = reapFixture('reuse');
  hostRuns({ ...BROWSER, startTime: 'Tue Nov 10 08:00:00 2026', command: '/usr/bin/other' });
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store);

    assert.deepEqual(summary.missingPids, [BROWSER.pid]);
    assert.deepEqual(processState.signals, []);
    assert.equal(store.read().length, 0);
  } finally {
    cleanup();
  }
});

test('startup keeps a record the host will not describe, as unconfirmed, without signaling it', async () => {
  const { store, cleanup } = reapFixture('unconfirmed');
  hostRuns(BROWSER);
  processState.mockRunCmd.mockResolvedValue({ stdout: '', stderr: 'timed out', exitCode: 1 });
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store);

    assert.deepEqual(summary.unconfirmedPids, [BROWSER.pid]);
    assert.deepEqual(summary.survivedPids, []);
    assert.deepEqual(processState.signals, []);
    assert.equal(store.read().length, 1);
  } finally {
    cleanup();
  }
});

test('startup keeps a confirmed process that outlives SIGKILL as survived, not as lost', async () => {
  const { store, cleanup } = reapFixture('survived');
  hostRuns(BROWSER);
  processState.exitsOnSignal = false;
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store, {
      termTimeoutMs: 1,
      killTimeoutMs: 1,
    });

    assert.deepEqual(summary.survivedPids, [BROWSER.pid]);
    assert.deepEqual(summary.unconfirmedPids, []);
    assert.deepEqual(processState.signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(store.read().length, 1);
  } finally {
    cleanup();
  }
});

test('startup does not force-kill or forget a live process whose command changes after SIGTERM', async () => {
  const { store, cleanup } = reapFixture('replaced');
  hostRuns(BROWSER);
  processState.exitsOnSignal = false;
  processState.commandAfterSignal = '/usr/bin/other --serve';
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store, {
      termTimeoutMs: 1,
      killTimeoutMs: 1,
    });

    assert.deepEqual(summary.unconfirmedPids, [BROWSER.pid]);
    assert.deepEqual(processState.signals, ['SIGTERM']);
    assert.equal(store.read().length, 1);
  } finally {
    cleanup();
  }
});

test('startup keeps a record whose recorded lifetime now shows another command, without signaling it', async () => {
  // A browser that rewrites its argv keeps its start time: that is not proof it is gone.
  const { store, cleanup } = reapFixture('argv-rewrite');
  hostRuns({ ...BROWSER, command: '/opt/chrome --type=browser' });
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store);

    assert.deepEqual(summary.unconfirmedPids, [BROWSER.pid]);
    assert.deepEqual(processState.signals, []);
    assert.equal(store.read().length, 1);
  } finally {
    cleanup();
  }
});

test('startup counts a pid reassigned after SIGTERM as missing, not terminated', async () => {
  const { store, cleanup } = reapFixture('reassigned-after-term');
  hostRuns(BROWSER);
  processState.exitsOnSignal = false;
  processState.startAfterSignal = 'Tue Nov 10 09:00:00 2026';
  try {
    store.replace({ kind: 'daemon' }, [BROWSER]);

    const summary = await reapOwnedProcessRecordsAtStartup(store, {
      termTimeoutMs: 1,
      killTimeoutMs: 1,
    });

    assert.deepEqual(summary.missingPids, [BROWSER.pid]);
    assert.deepEqual(summary.terminatedPids, []);
    assert.deepEqual(processState.signals, ['SIGTERM']);
    assert.equal(store.read().length, 0);
  } finally {
    cleanup();
  }
});
