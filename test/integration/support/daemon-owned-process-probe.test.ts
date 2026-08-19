import { describe, expect, test } from 'vitest';
import { findOwnedProcesses, type HostProcess } from './daemon-owned-process-probe.ts';

// The probe is manual — no lane can run it, because a device-free daemon owns no
// children (see its header). These fixtures are the real `ps` rows captured
// during the #1109 and #1324 red-proofs (SHAs in the #1781 B1 PR), so a regex or
// ordering edit that stops catching either leak fails here rather than silently
// weakening the next hand-run proof.
const STATE_DIR = '/tmp/agent-device-lane-abc';
const DAEMON_PID = 4340;

function proc(overrides: Partial<HostProcess> & Pick<HostProcess, 'pid'>): HostProcess {
  return { ppid: 1, pgid: overrides.pid, command: 'unrelated', env: '', ...overrides };
}

const owned = (processes: HostProcess[]) => findOwnedProcesses(processes, [DAEMON_PID], STATE_DIR);

describe('daemon-owned process rules', () => {
  // #1324: `simctl io … recordVideo` reparents to launchd (ppid 1) but keeps the
  // dead daemon's process group, and simctl only finalizes the mp4 on SIGINT.
  test('flags a recorder orphaned into the dead daemon process group', () => {
    const recorder = proc({
      pid: 52420,
      ppid: 1,
      pgid: DAEMON_PID,
      command: '/…/simctl io 416440AE recordVideo /tmp/out.mp4',
    });

    expect(owned([recorder])).toEqual([
      expect.objectContaining({ pid: 52420, reasons: ['process-group'] }),
    ]);
  });

  // #1109: the agent-browser daemon setsids away from the daemon's group, so
  // only the inherited state-dir environment and its argv identify the fleet.
  test('flags an agent-browser fleet by inherited state dir, including its children', () => {
    const browserDaemon = proc({
      pid: 47515,
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
    const matches = owned([browserDaemon, chrome, renderer]);

    expect(matches.map((match) => match.pid)).toEqual([47515, 47586, 47953]);
    expect(matches[0]?.reasons).toEqual(['state-dir-env', 'state-dir-argv']);
    // The fleet below the matched root is owned transitively, not by its own argv.
    expect(matches[1]?.reasons).toEqual(['descendant']);
  });

  test('ignores foreign processes, a neighbouring state dir, and the daemon itself', () => {
    const simulator = proc({ pid: 700, command: '/…/CoreSimulator … SimulatorTrampoline' });
    const neighbour = proc({
      pid: 701,
      command: `node --state-dir ${STATE_DIR}-other/daemon.ts`,
      env: `AGENT_DEVICE_STATE_DIR=${STATE_DIR}-other`,
    });
    const daemon = proc({ pid: DAEMON_PID, pgid: DAEMON_PID });

    expect(owned([simulator, neighbour, daemon])).toEqual([]);
  });
});
