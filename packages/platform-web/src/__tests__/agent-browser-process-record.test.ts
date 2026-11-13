import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import type { OwnedProcessRecord } from '@agent-device/contracts/platform-runtime-host';
import type {
  HostProcessIdentityObservation,
  OwnedProcessRecordStore,
} from '@agent-device/host-kit/process';
import {
  MANAGED_WEB_BROWSER_PROCESS_PURPOSE,
  managedWebBrowserProcessRecordIsDead,
  managedWebBrowserProcessRecordIsLive,
} from '../agent-browser-process-record.ts';

const { observationsMock, isProcessAliveMock } = vi.hoisted(() => ({
  isProcessAliveMock: vi.fn((_pid: number) => false),
  observationsMock: vi.fn(
    async (_pids: Iterable<number>) => new Map<number, HostProcessIdentityObservation>(),
  ),
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  readHostProcessIdentityObservationsAsync: observationsMock,
  isProcessAlive: isProcessAliveMock,
}));

const mockObservations = vi.mocked(observationsMock);
const mockIsProcessAlive = vi.mocked(isProcessAliveMock);

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

/** The host names every requested pid, alive under the start time the record carries. */
function hostNamesEveryRequestedPid(): void {
  mockObservations.mockImplementation(async (pidsArg: Iterable<number>) => {
    const observations = new Map<number, HostProcessIdentityObservation>();
    for (const pid of pidsArg) observations.set(pid, { state: 'Ss', startTime: `start-${pid}` });
    return observations;
  });
}

function hostAnswers(observations: Map<number, HostProcessIdentityObservation>): void {
  mockObservations.mockResolvedValue(observations);
}

beforeEach(() => {
  mockObservations.mockReset();
  mockObservations.mockResolvedValue(new Map());
  mockIsProcessAlive.mockReset();
  mockIsProcessAlive.mockReturnValue(false);
});

test('a record whose every managed process is alive under its recorded identity is live', async () => {
  hostNamesEveryRequestedPid();
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(
      storeReturning([daemonEntry([record(11), record(12)])]),
    ),
    true,
  );
  // The probe is one batched same-pid snapshot, not a scan of every host process.
  assert.equal(mockObservations.mock.calls.length, 1);
  assert.deepEqual([...mockObservations.mock.calls[0]![0]], [11, 12]);
});

test('a process the host cannot name makes the record not-live', async () => {
  hostAnswers(
    new Map([
      [11, { state: 'Ss', startTime: 'start-11' } satisfies HostProcessIdentityObservation],
    ]),
  );
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(
      storeReturning([daemonEntry([record(11), record(12)])]),
    ),
    false,
  );
});

test('a pid answering under a different start time is pid reuse, not the recorded fleet', async () => {
  hostAnswers(
    new Map([
      [11, { state: 'Ss', startTime: 'a-later-boot' } satisfies HostProcessIdentityObservation],
    ]),
  );
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(storeReturning([daemonEntry([record(11)])])),
    false,
  );
});

test('a recorded zombie is not a live fleet even with its start time intact', async () => {
  hostAnswers(
    new Map([
      [11, { state: 'ZN', startTime: 'start-11' } satisfies HostProcessIdentityObservation],
    ]),
  );
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(storeReturning([daemonEntry([record(11)])])),
    false,
  );
});

test('a probe that answers nothing is unknown evidence, which reads as not-live', async () => {
  hostAnswers(new Map());
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(storeReturning([daemonEntry([record(11)])])),
    false,
  );
});

test('an empty record is not a live fleet and needs no probe', async () => {
  assert.equal(await managedWebBrowserProcessRecordIsLive(storeReturning([])), false);
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(storeReturning([daemonEntry([])])),
    false,
  );
  assert.equal(mockObservations.mock.calls.length, 0);
});

test('a session-scoped record is not the daemon-scoped managed fleet', async () => {
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(storeReturning([sessionEntry([record(11)])])),
    false,
  );
  assert.equal(mockObservations.mock.calls.length, 0);
});

test('a record of another purpose is not the managed fleet', async () => {
  const store = storeReturning([
    daemonEntry([
      { pid: 11, startTime: 'start-11', command: 'command-11', purpose: 'simctl-screen-recording' },
    ]),
  ]);
  assert.equal(await managedWebBrowserProcessRecordIsLive(store), false);
  assert.equal(mockObservations.mock.calls.length, 0);
});

test('an undecodable record is not a live fleet and needs no probe', async () => {
  assert.equal(
    await managedWebBrowserProcessRecordIsLive(storeReturning([undecodableDaemonEntry()])),
    false,
  );
  assert.equal(mockObservations.mock.calls.length, 0);
});

test('a store that cannot answer reads as not-live, which sends the caller back to the scan', async () => {
  const store = storeReturning(() => {
    throw new Error('record file unreadable');
  });
  assert.equal(await managedWebBrowserProcessRecordIsLive(store), false);
  assert.equal(mockObservations.mock.calls.length, 0);
});

test('a record is dead only when every recorded process was observed not alive', async () => {
  hostAnswers(
    new Map([
      [11, { state: 'ZN', startTime: 'start-11' } satisfies HostProcessIdentityObservation],
      [12, { state: 'Ss', startTime: 'a-later-boot' } satisfies HostProcessIdentityObservation],
    ]),
  );
  assert.equal(
    await managedWebBrowserProcessRecordIsDead(
      storeReturning([daemonEntry([record(11), record(12), record(13)])]),
    ),
    true,
  );
});

test('a recorded process still answering alive keeps the record from being dead', async () => {
  hostAnswers(
    new Map([
      [11, { state: 'ZN', startTime: 'start-11' } satisfies HostProcessIdentityObservation],
      [12, { state: 'Ss', startTime: 'start-12' } satisfies HostProcessIdentityObservation],
    ]),
  );
  assert.equal(
    await managedWebBrowserProcessRecordIsDead(
      storeReturning([daemonEntry([record(11), record(12)])]),
    ),
    false,
  );
});

test('an unanswered probe is unknown evidence, not a dead record', async () => {
  hostAnswers(new Map());
  mockIsProcessAlive.mockReturnValue(true);
  assert.equal(
    await managedWebBrowserProcessRecordIsDead(storeReturning([daemonEntry([record(11)])])),
    false,
  );
});

test('an empty or undecodable record is not dead and needs no probe', async () => {
  assert.equal(await managedWebBrowserProcessRecordIsDead(storeReturning([])), false);
  assert.equal(
    await managedWebBrowserProcessRecordIsDead(storeReturning([undecodableDaemonEntry()])),
    false,
  );
  assert.equal(mockObservations.mock.calls.length, 0);
});

test.each([
  ['Mon Aug 10 20:00:00 2026', 'linux:11111111-1111-4111-8111-111111111111:12345'],
  ['linux:11111111-1111-4111-8111-111111111111:12345', 'Mon Aug 10 20:00:00 2026'],
])(
  'incomparable process lifetimes prove neither a live nor a dead browser fleet',
  async (recorded, observed) => {
    mockIsProcessAlive.mockReturnValue(true);
    mockObservations.mockResolvedValue(new Map([[11, { state: 'Ss', startTime: observed }]]));
    const store = storeReturning([daemonEntry([record(11, recorded)])]);
    assert.equal(await managedWebBrowserProcessRecordIsLive(store), false);
    assert.equal(await managedWebBrowserProcessRecordIsDead(store), false);
  },
);
