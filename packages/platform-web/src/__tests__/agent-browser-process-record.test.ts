import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type {
  OwnedProcessRecord,
  RecordedProcessLiveness,
} from '@agent-device/contracts/platform-runtime-host';
import type { PlatformHost } from 'agent-device/plugins';
import type { OwnedProcessRecordStore } from '@agent-device/host-kit/process';
import {
  MANAGED_WEB_BROWSER_PROCESS_PURPOSE,
  managedWebBrowserProcessRecordIsDead,
  managedWebBrowserProcessRecordIsLive,
} from '../agent-browser-process-record.ts';

// Whether a recorded process is still the one the record names is the host's rule, not this family's:
// the start-time format, the zombie state and the signal probe all belong to the process that owns
// process reads. So the probes below are asked of the `processes` port and nothing else — the plugin
// carries a host-kit copy of its own, and reading a record with that copy would judge a machine it does
// not run its commands on (R13).
const { judgeMock } = vi.hoisted(() => ({
  judgeMock: vi.fn(
    async (_records: readonly OwnedProcessRecord[]) => [] as readonly RecordedProcessLiveness[],
  ),
}));

const mockJudge = vi.mocked(judgeMock);

/** The process facet the two record probes are asked to use. Only the judgement is reached. */
function createProcessPort(): PlatformHost['processes'] {
  return {
    list: async () => [],
    readIdentities: async () => new Map(),
    expandTree: (rootPids, processes) =>
      [...processes].filter((processInfo) => [...rootPids].includes(processInfo.pid)),
    judgeRecordedLiveness: (records) => mockJudge(records),
    readExecutablePaths: async () => new Map(),
    reapOwnedRecords: async () => {
      throw new Error('the record probe never reaps');
    },
    withLock: async () => {
      throw new Error('the record probe takes no host lock');
    },
  };
}

const processes = createProcessPort();

function record(pid: number, startTime = `start-${pid}`): OwnedProcessRecord {
  return {
    pid,
    startTime,
    command: `command-${pid}`,
    purpose: MANAGED_WEB_BROWSER_PROCESS_PURPOSE,
  };
}

type RecordRead = ReturnType<OwnedProcessRecordStore['read']>;

function storeReturning(entries: RecordRead | (() => RecordRead)): OwnedProcessRecordStore {
  return {
    replace: vi.fn(),
    clear: vi.fn(),
    read: typeof entries === 'function' ? vi.fn(entries) : vi.fn(() => entries),
  };
}

function daemonEntry(records: readonly OwnedProcessRecord[]) {
  return {
    scope: { kind: 'daemon' as const },
    path: '/state/owned-processes.json',
    status: 'decoded' as const,
    records,
  };
}

function sessionEntry(records: readonly OwnedProcessRecord[]) {
  return {
    scope: { kind: 'session' as const, sessionId: 'web' },
    path: '/state/sessions/web/owned-processes.json',
    status: 'decoded' as const,
    records,
  };
}

function undecodableDaemonEntry() {
  return {
    scope: { kind: 'daemon' as const },
    path: '/state/owned-processes.json',
    status: 'invalid' as const,
    records: [],
    message: 'owned process record must contain version 1 and a processes array',
  };
}

/** The host answers each record it was handed with `state`, in the order it received them. */
function hostJudges(state: RecordedProcessLiveness): void {
  mockJudge.mockImplementation(async (records) => records.map(() => state));
}

beforeEach(() => {
  mockJudge.mockReset();
  mockJudge.mockResolvedValue([]);
});

test('a record whose every managed process the host vouches for is live', async () => {
  hostJudges('alive');
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(
      storeReturning([daemonEntry([record(11), record(12)])]),
      processes,
    ),
    true,
  );
  // One judgement for the whole record, handed the recorded pids and their start times together.
  assert.equal(mockJudge.mock.calls.length, 1);
  assert.deepEqual(
    mockJudge.mock.calls[0]![0].map(({ pid, startTime }) => [pid, startTime]),
    [
      [11, 'start-11'],
      [12, 'start-12'],
    ],
  );
});

test('a record the host judges partly alive is neither live nor dead', async () => {
  mockJudge.mockResolvedValue(['alive', 'not-alive']);
  const store = storeReturning([daemonEntry([record(11), record(12)])]);
  assert.equal(await managedWebBrowserProcessRecordIsLive(store, processes), false);
  assert.equal(await managedWebBrowserProcessRecordIsDead(store, processes), false);
});

test('a process under a reused pid makes the record not-live', async () => {
  mockJudge.mockResolvedValue(['not-alive']);
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(
      storeReturning([daemonEntry([record(11)])]),
      processes,
    ),
    false,
  );
});

test('a host that observed nothing keeps the record from reading as live or dead', async () => {
  // Unknown evidence is what the host answers for a process table that failed, or for a start time
  // recorded in another machine's format: the caller rescans rather than acting on either verdict.
  hostJudges('unobserved');
  const store = storeReturning([daemonEntry([record(11)])]);
  assert.equal(await managedWebBrowserProcessRecordIsLive(store, processes), false);
  assert.equal(await managedWebBrowserProcessRecordIsDead(store, processes), false);
});

test('an empty record is neither live nor dead and needs no judgement', async () => {
  assert.equal(await managedWebBrowserProcessRecordIsLive(storeReturning([]), processes), false);
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(storeReturning([daemonEntry([])]), processes),
    false,
  );
  assert.equal(await managedWebBrowserProcessRecordIsDead(storeReturning([]), processes), false);
  assert.equal(mockJudge.mock.calls.length, 0);
});

test('a session-scoped record is not the daemon-scoped managed fleet', async () => {
  hostJudges('alive');
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(
      storeReturning([sessionEntry([record(11)])]),
      processes,
    ),
    false,
  );
  assert.equal(mockJudge.mock.calls.length, 0);
});

test('a record of another purpose is not the managed fleet', async () => {
  hostJudges('alive');
  const store = storeReturning([
    daemonEntry([
      { pid: 11, startTime: 'start-11', command: 'command-11', purpose: 'simctl-screen-recording' },
    ]),
  ]);
  assert.equal(await managedWebBrowserProcessRecordIsLive(store, processes), false);
  assert.equal(mockJudge.mock.calls.length, 0);
});

test('an undecodable record is neither live nor dead and needs no judgement', async () => {
  hostJudges('alive');
  const store = storeReturning([undecodableDaemonEntry()]);
  assert.equal(await managedWebBrowserProcessRecordIsLive(store, processes), false);
  assert.equal(await managedWebBrowserProcessRecordIsDead(store, processes), false);
  assert.equal(mockJudge.mock.calls.length, 0);
});

test('a store that cannot answer reads as not-live, which sends the caller back to the scan', async () => {
  hostJudges('alive');
  const store = storeReturning(() => {
    throw new Error('record file unreadable');
  });
  assert.equal(await managedWebBrowserProcessRecordIsLive(store, processes), false);
  assert.equal(mockJudge.mock.calls.length, 0);
});

test('a record is dead only when the host judges every recorded process gone', async () => {
  hostJudges('not-alive');
  assert.equal(
    await managedWebBrowserProcessRecordIsDead(
      storeReturning([daemonEntry([record(11), record(12), record(13)])]),
      processes,
    ),
    true,
  );
});
