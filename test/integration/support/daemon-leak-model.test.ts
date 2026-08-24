import { describe, expect, test } from 'vitest';
import {
  evaluateDaemonLeaks,
  formatDaemonLeakReport,
  hasDaemonLeaks,
  type DaemonLeakObservation,
  type DaemonLeakObservationBase,
  type DaemonLeakPhaseSelection,
  type NonEmpty,
  type StateEntry,
} from './daemon-leak-model.ts';

const STATE_DIR = '/tmp/agent-device-lane-abc';
const DAEMON_PID = 4340;

// The phase and its identity arrive together: `after-close` cannot be requested
// without naming the sessions that closed, so these helpers cannot construct the
// vacuous checkpoint either.
function observe(
  overrides: Partial<DaemonLeakObservationBase> = {},
  selection: DaemonLeakPhaseSelection = { phase: 'after-shutdown' },
): DaemonLeakObservation {
  return {
    stateDir: STATE_DIR,
    daemonPids: [DAEMON_PID],
    livePids: [],
    ownedProcessRecords: [],
    stateEntries: [],
    ...overrides,
    ...selection,
  };
}

function observeAfterClose(
  closedSessions: NonEmpty<string>,
  overrides: Partial<DaemonLeakObservationBase> = {},
): DaemonLeakObservation {
  return observe(
    { livePids: [DAEMON_PID], ...overrides },
    { phase: 'after-close', closedSessions },
  );
}

function file(entryPath: string, descriptorLifecycle?: string): StateEntry {
  return { path: entryPath, kind: 'file', ...(descriptorLifecycle ? { descriptorLifecycle } : {}) };
}

function ownedProcess(
  pid: number,
  purpose: string,
  scope: 'daemon' | 'session' = 'daemon',
  sessionId?: string,
): DaemonLeakObservationBase['ownedProcessRecords'][number] {
  const record = {
    pid,
    startTime: `start-${pid}`,
    command: `command-${pid}`,
    purpose,
  };
  return {
    scope,
    ...(sessionId === undefined ? {} : { sessionId }),
    recordPath:
      scope === 'daemon' ? 'owned-processes.json' : `sessions/${sessionId}/owned-processes.json`,
    records: [record],
    liveRecords: [record],
    status: 'decoded',
  };
}

function ownedProcesses(
  pids: readonly number[],
  purpose: string,
  scope: 'daemon' | 'session' = 'daemon',
  sessionId?: string,
): DaemonLeakObservationBase['ownedProcessRecords'][number] {
  const entry = ownedProcess(pids[0]!, purpose, scope, sessionId);
  const records = pids.map((pid) => ({
    pid,
    startTime: `start-${pid}`,
    command: `command-${pid}`,
    purpose,
  }));
  return { ...entry, records, liveRecords: records };
}

describe('recorded owned-process rules', () => {
  // #1324: the simctl recorder is represented by the spawn owner's exact
  // identity, even though launchd reparents it away from the daemon.
  test('flags a live simctl recorder from the session-owned record', () => {
    const snapshot = evaluateDaemonLeaks(
      observe({
        ownedProcessRecords: [ownedProcess(52420, 'simctl-screen-recording', 'session', 'record')],
      }),
    );

    expect(snapshot.ownedProcesses).toEqual([
      expect.objectContaining({
        pid: 52420,
        purpose: 'simctl-screen-recording',
        recordPath: 'sessions/record/owned-processes.json',
      }),
    ]);
    expect(hasDaemonLeaks(snapshot)).toBe(true);
  });

  // #1109: the managed agent-browser daemon and its Chrome fleet are recorded
  // at their owner seam; the leak oracle does not need PPID, PGID, env, or argv
  // heuristics to identify them after the daemon dies.
  test('flags a live managed-browser fleet from the daemon-owned record', () => {
    const snapshot = evaluateDaemonLeaks(
      observe({
        ownedProcessRecords: [ownedProcesses([47515, 47586, 47953], 'managed-web-browser')],
      }),
    );

    expect(snapshot.ownedProcesses.map(({ pid }) => pid)).toEqual([47515, 47586, 47953]);
    expect(formatDaemonLeakReport(snapshot)).toContain('managed-web-browser: pid 47515');
  });

  test('fails closed when a recorded pid no longer matches its identity', () => {
    const entry = ownedProcess(47515, 'managed-web-browser');
    const snapshot = evaluateDaemonLeaks(
      observe({
        ownedProcessRecords: [{ ...entry, liveRecords: [], ownershipLostRecords: entry.records }],
      }),
    );

    expect(snapshot.ownedProcesses).toEqual([
      expect.objectContaining({ pid: 47515, ownership: 'lost' }),
    ]);
    expect(formatDaemonLeakReport(snapshot)).toContain('(ownership lost)');
    expect(hasDaemonLeaks(snapshot)).toBe(true);
  });

  test('does not flag a daemon-scoped process during the after-close checkpoint', () => {
    const snapshot = evaluateDaemonLeaks(
      observeAfterClose(['closed-one'], {
        ownedProcessRecords: [ownedProcess(47515, 'managed-web-browser')],
      }),
    );

    expect(snapshot.ownedProcesses).toEqual([]);
    expect(hasDaemonLeaks(snapshot)).toBe(false);
  });

  test('flags a process record belonging to the session that just closed', () => {
    const snapshot = evaluateDaemonLeaks(
      observeAfterClose(['closed-one'], {
        ownedProcessRecords: [
          ownedProcess(52420, 'simctl-screen-recording', 'session', 'closed-one'),
        ],
      }),
    );

    expect(snapshot.ownedProcesses.map(({ pid }) => pid)).toEqual([52420]);
  });
});

describe('surviving-daemon rule', () => {
  // stopProcessForTakeover is best-effort void: it returns silently on identity
  // mismatch, signal failure, or kill timeout, so a daemon can outlive the stop.
  test('a daemon still alive after shutdown is itself a leak', () => {
    const snapshot = evaluateDaemonLeaks(
      observe({ livePids: [DAEMON_PID], stateEntries: [file('daemon.log')] }),
    );

    expect(snapshot.liveDaemonPids).toEqual([DAEMON_PID]);
    expect(hasDaemonLeaks(snapshot)).toBe(true);
    expect(formatDaemonLeakReport(snapshot)).toContain('daemons that outlived shutdown: 1');
  });

  test('its metadata files stay stray rather than being excused by its own survival', () => {
    const snapshot = evaluateDaemonLeaks(
      observe({ livePids: [DAEMON_PID], stateEntries: [file('daemon.json'), file('daemon.lock')] }),
    );

    expect(snapshot.strayStateEntries).toEqual(['daemon.json', 'daemon.lock']);
  });

  test('a live daemon is expected while a session merely closed', () => {
    const snapshot = evaluateDaemonLeaks(
      observeAfterClose(['closed-one'], {
        stateEntries: [file('daemon.json'), file('daemon.lock')],
      }),
    );

    expect(hasDaemonLeaks(snapshot)).toBe(false);
  });
});

describe('state-dir residue rules', () => {
  const AFTER_SHUTDOWN: DaemonLeakPhaseSelection = { phase: 'after-shutdown' };
  // A different session from the one this entry belongs to, so the row proves the
  // phase rule rather than the closed-session rule.
  const AFTER_CLOSE: DaemonLeakPhaseSelection = {
    phase: 'after-close',
    closedSessions: ['closed-one'],
  };

  test.each<[string, StateEntry, DaemonLeakPhaseSelection, 'expected' | 'stray']>([
    ['session event log', file('sessions/default/events.ndjson'), AFTER_SHUTDOWN, 'expected'],
    ['request diagnostics', file('sessions/d/requests/abc.ndjson'), AFTER_SHUTDOWN, 'expected'],
    ['shutdown report', file('daemon-shutdown.json'), AFTER_SHUTDOWN, 'expected'],
    ['torn publish temporary', file('device-claims/a.json.55.tmp'), AFTER_SHUTDOWN, 'stray'],
    [
      'managed tool download',
      file('tools/agent-browser/0.27.1/dl.tmp'),
      AFTER_SHUTDOWN,
      'expected',
    ],
    [
      'unswept artifact scaffold',
      { path: 'sessions/d/artifacts/pending/', kind: 'empty-directory' },
      AFTER_SHUTDOWN,
      'stray',
    ],
    [
      'unswept session scaffold',
      { path: 'sessions/leaked/requests/', kind: 'empty-directory' },
      AFTER_SHUTDOWN,
      'stray',
    ],
    ['unknown artifact', file('sessions/d/mystery.bin'), AFTER_SHUTDOWN, 'stray'],
    [
      'open capture descriptor',
      file('sessions/d/screen-recording.resource.json', 'open'),
      AFTER_SHUTDOWN,
      'stray',
    ],
    [
      'completed capture descriptor',
      file('sessions/d/screen-recording.resource.json', 'completed'),
      AFTER_SHUTDOWN,
      'expected',
    ],
    [
      "another session's open capture during close",
      file('sessions/other/screen-recording.resource.json', 'open'),
      AFTER_CLOSE,
      'expected',
    ],
    ['legacy app-log marker', file('sessions/d/app-log.pid'), AFTER_SHUTDOWN, 'stray'],
    [
      'valid owned-process record',
      { ...file('owned-processes.json'), ownedProcessRecordStatus: 'decoded' },
      AFTER_SHUTDOWN,
      'expected',
    ],
    [
      'invalid owned-process record',
      { ...file('owned-processes.json'), ownedProcessRecordStatus: 'invalid' },
      AFTER_SHUTDOWN,
      'stray',
    ],
  ])('%s is %s', (_name, entry, selection, verdict) => {
    const snapshot = evaluateDaemonLeaks(observe({ stateEntries: [entry] }, selection));

    expect(snapshot.strayStateEntries).toEqual(verdict === 'stray' ? [entry.path] : []);
  });

  // A managed install tree is third-party output the daemon neither writes nor
  // owns, so its own temporaries must not be read as our torn publish.
  test('the managed tools exemption does not leak into daemon-written paths', () => {
    const snapshot = evaluateDaemonLeaks(
      observe({ stateEntries: [file('sessions/d/tools/pending.tmp')] }),
    );

    expect(snapshot.strayStateEntries).toEqual(['sessions/d/tools/pending.tmp']);
  });
});

// The phase only means something if it can name the session that closed: without
// that, the closed session's unfinalized capture handle is indistinguishable
// from another session's legitimately live one, and `after-close` certifies
// nothing. Wired through by the session-close route regression in
// test/integration/provider-scenarios/session-close-leak-oracle.test.ts.
describe('closed-session capture handles', () => {
  const closedSessionCapture = (lifecycle: string) =>
    file('sessions/closed-one/screen-recording.resource.json', lifecycle);
  const afterClose = (stateEntries: StateEntry[]): DaemonLeakObservation =>
    observeAfterClose(['closed-one'], { stateEntries });

  test('the closed session must have finalized its capture handle', () => {
    const snapshot = evaluateDaemonLeaks(afterClose([closedSessionCapture('open')]));

    expect(snapshot.strayStateEntries).toEqual([
      'sessions/closed-one/screen-recording.resource.json',
    ]);
    expect(hasDaemonLeaks(snapshot)).toBe(true);
  });

  test('a session that did not close may still hold a live capture handle', () => {
    const snapshot = evaluateDaemonLeaks(
      afterClose([file('sessions/still-open/screen-recording.resource.json', 'open')]),
    );

    expect(hasDaemonLeaks(snapshot)).toBe(false);
  });

  test('a finalized handle from the closed session is its finish record', () => {
    const snapshot = evaluateDaemonLeaks(afterClose([closedSessionCapture('completed')]));

    expect(hasDaemonLeaks(snapshot)).toBe(false);
  });

  test('a legacy pid marker is never a finish record for the closed session', () => {
    const snapshot = evaluateDaemonLeaks(afterClose([file('sessions/closed-one/app-log.pid')]));

    expect(snapshot.strayStateEntries).toEqual(['sessions/closed-one/app-log.pid']);
  });
});

test('a clean shutdown reports no leak', () => {
  const snapshot = evaluateDaemonLeaks(
    observe({
      stateEntries: [file('daemon.log'), file('sessions/default/events.ndjson')],
    }),
  );

  expect(hasDaemonLeaks(snapshot)).toBe(false);
  expect(formatDaemonLeakReport(snapshot)).toContain('daemon leak oracle: clean (after-shutdown)');
});
