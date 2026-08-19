import { describe, expect, test } from 'vitest';
import {
  evaluateDaemonLeaks,
  formatDaemonLeakReport,
  hasDaemonLeaks,
  type DaemonLeakObservation,
  type DaemonLeakPhase,
  type HostProcess,
  type StateEntry,
} from './daemon-leak-model.ts';

// The lanes that call the oracle run device-free daemons, so the ownership rules
// would otherwise only ever see an empty process set. These fixtures are the
// real `ps` shapes captured during the #1109 and #1324 red-proofs (SHAs in the
// #1781 B1 PR), so a regex or ordering edit that stops catching either leak
// fails here instead of silently going quiet in CI.
const STATE_DIR = '/tmp/agent-device-lane-abc';
const DAEMON_PID = 4340;
const OBSERVER_PID = 999;

function proc(overrides: Partial<HostProcess> & Pick<HostProcess, 'pid'>): HostProcess {
  return { ppid: 1, pgid: overrides.pid, command: 'unrelated', env: '', ...overrides };
}

function observe(overrides: Partial<DaemonLeakObservation> = {}): DaemonLeakObservation {
  return {
    stateDir: STATE_DIR,
    daemonPids: [DAEMON_PID],
    livePids: [],
    phase: 'after-shutdown',
    processes: [],
    excludedPids: [OBSERVER_PID],
    closedSessions: [],
    stateEntries: [],
    ...overrides,
  };
}

function file(entryPath: string, descriptorLifecycle?: string): StateEntry {
  return { path: entryPath, kind: 'file', ...(descriptorLifecycle ? { descriptorLifecycle } : {}) };
}

describe('owned-process rules', () => {
  // #1324: `simctl io … recordVideo` reparents to launchd (ppid 1) but keeps the
  // dead daemon's process group, and simctl only finalizes the mp4 on SIGINT.
  test('flags a recorder orphaned into the dead daemon process group', () => {
    const recorder = proc({
      pid: 52420,
      ppid: 1,
      pgid: DAEMON_PID,
      command: '/…/simctl io 416440AE recordVideo /tmp/out.mp4',
    });
    const snapshot = evaluateDaemonLeaks(observe({ processes: [recorder] }));

    expect(snapshot.ownedProcesses).toEqual([
      expect.objectContaining({ pid: 52420, reasons: ['process-group'] }),
    ]);
    expect(hasDaemonLeaks(snapshot)).toBe(true);
  });

  // #1109: the agent-browser daemon setsids away from the daemon's group, so
  // only the inherited state-dir environment and its argv identify the fleet.
  test('flags an agent-browser fleet by inherited state dir, including its children', () => {
    const browserDaemon = proc({
      pid: 47515,
      ppid: 1,
      pgid: 47515,
      command: `${STATE_DIR}/tools/agent-browser/0.27.1/package/…/agent-browser-darwin-arm64`,
      env: `HOME=/tmp AGENT_DEVICE_STATE_DIR=${STATE_DIR}`,
    });
    const chrome = proc({
      pid: 47586,
      ppid: 47515,
      pgid: 47586,
      command: 'Google Chrome for Testing',
    });
    const renderer = proc({
      pid: 47953,
      ppid: 47586,
      pgid: 47586,
      command: 'Chrome Helper (Renderer)',
    });
    const snapshot = evaluateDaemonLeaks(observe({ processes: [browserDaemon, chrome, renderer] }));

    expect(snapshot.ownedProcesses.map((owned) => owned.pid)).toEqual([47515, 47586, 47953]);
    expect(snapshot.ownedProcesses[0]?.reasons).toEqual(['state-dir-env', 'state-dir-argv']);
    // The fleet below the matched root is owned transitively, not by its own argv.
    expect(snapshot.ownedProcesses[1]?.reasons).toEqual(['descendant']);
  });

  test('ignores foreign processes, the observer chain, and the daemons themselves', () => {
    const simulator = proc({ pid: 700, command: '/…/CoreSimulator … SimulatorTrampoline' });
    const neighbourStateDir = proc({
      pid: 701,
      command: `node --state-dir ${STATE_DIR}-other/daemon.ts`,
      env: `AGENT_DEVICE_STATE_DIR=${STATE_DIR}-other`,
    });
    const observer = proc({ pid: OBSERVER_PID, pgid: DAEMON_PID });
    const daemon = proc({ pid: DAEMON_PID, pgid: DAEMON_PID });
    const snapshot = evaluateDaemonLeaks(
      observe({ processes: [simulator, neighbourStateDir, observer, daemon] }),
    );

    expect(snapshot.ownedProcesses).toEqual([]);
    expect(hasDaemonLeaks(snapshot)).toBe(false);
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
      observe({
        phase: 'after-close',
        livePids: [DAEMON_PID],
        stateEntries: [file('daemon.json'), file('daemon.lock')],
      }),
    );

    expect(hasDaemonLeaks(snapshot)).toBe(false);
  });
});

describe('state-dir residue rules', () => {
  test.each<[string, StateEntry, DaemonLeakPhase, 'expected' | 'stray']>([
    ['session event log', file('sessions/default/events.ndjson'), 'after-shutdown', 'expected'],
    ['request diagnostics', file('sessions/d/requests/abc.ndjson'), 'after-shutdown', 'expected'],
    ['shutdown report', file('daemon-shutdown.json'), 'after-shutdown', 'expected'],
    ['torn publish temporary', file('device-claims/a.json.55.tmp'), 'after-shutdown', 'stray'],
    [
      'managed tool download',
      file('tools/agent-browser/0.27.1/dl.tmp'),
      'after-shutdown',
      'expected',
    ],
    [
      'unswept artifact scaffold',
      { path: 'sessions/d/artifacts/pending/', kind: 'empty-directory' },
      'after-shutdown',
      'stray',
    ],
    [
      'unswept session scaffold',
      { path: 'sessions/leaked/requests/', kind: 'empty-directory' },
      'after-shutdown',
      'stray',
    ],
    ['unknown artifact', file('sessions/d/mystery.bin'), 'after-shutdown', 'stray'],
    [
      'open capture descriptor',
      file('sessions/d/screen-recording.resource.json', 'open'),
      'after-shutdown',
      'stray',
    ],
    [
      'completed capture descriptor',
      file('sessions/d/screen-recording.resource.json', 'completed'),
      'after-shutdown',
      'expected',
    ],
    [
      "another session's open capture during close",
      file('sessions/other/screen-recording.resource.json', 'open'),
      'after-close',
      'expected',
    ],
    ['legacy app-log marker', file('sessions/d/app-log.pid'), 'after-shutdown', 'stray'],
  ])('%s is %s at %s', (_name, entry, phase, verdict) => {
    const snapshot = evaluateDaemonLeaks(observe({ phase, stateEntries: [entry] }));

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
    observe({
      phase: 'after-close',
      livePids: [DAEMON_PID],
      closedSessions: ['closed-one'],
      stateEntries,
    });

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
      processes: [proc({ pid: 700, command: 'unrelated' })],
      stateEntries: [file('daemon.log'), file('sessions/default/events.ndjson')],
    }),
  );

  expect(hasDaemonLeaks(snapshot)).toBe(false);
  expect(formatDaemonLeakReport(snapshot)).toContain('daemon leak oracle: clean (after-shutdown)');
});
