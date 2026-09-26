import { describe, expect, test } from 'vitest';
import {
  advanceRunnerSessionState,
  canWorkWithRunnerSession,
  resolveRunnerSessionLiveness,
  RunnerCommandAccounting,
  type RunnerSessionState,
} from '../runner-session-types.ts';

// The state table is the single place a runner session's lifecycle moves (#2662); these pins keep
// it from quietly gaining an edge that revives a session or tears one down twice.

const ALL_STATES: readonly RunnerSessionState[] = ['starting', 'ready', 'draining', 'stopped'];

function held(state: RunnerSessionState) {
  return { state };
}

describe('advanceRunnerSessionState', () => {
  test('advances a session along the legal lifecycle', () => {
    const session = held('starting');

    advanceRunnerSessionState(session, 'ready');
    expect(session.state).toBe('ready');

    advanceRunnerSessionState(session, 'draining');
    expect(session.state).toBe('draining');

    advanceRunnerSessionState(session, 'stopped');
    expect(session.state).toBe('stopped');
  });

  test('hands a healthy runner straight to the next daemon at shutdown', () => {
    // The graceful-shutdown handoff writes a detached lease and never disposes, so there is no
    // `draining` in between even though the runner process keeps running.
    const session = held('ready');

    advanceRunnerSessionState(session, 'stopped');

    expect(session.state).toBe('stopped');
  });

  test('hands an unanswering startup to the next daemon too', () => {
    const session = held('starting');

    advanceRunnerSessionState(session, 'stopped');

    expect(session.state).toBe('stopped');
  });

  test('never moves a session backwards', () => {
    const cases: ReadonlyArray<readonly [RunnerSessionState, RunnerSessionState]> = [
      ['ready', 'starting'],
      ['draining', 'ready'],
      ['draining', 'starting'],
      ['stopped', 'ready'],
      ['stopped', 'starting'],
      ['stopped', 'draining'],
    ];

    for (const [from, attempted] of cases) {
      const session = held(from);
      advanceRunnerSessionState(session, attempted);
      expect(session.state, `${from} -> ${attempted}`).toBe(from);
    }
  });

  test('lets a starting session stop without ever answering', () => {
    const session = held('starting');

    advanceRunnerSessionState(session, 'draining');

    expect(session.state).toBe('draining');
  });

  test('is idempotent, so a repeated transition changes nothing', () => {
    const session = held('ready');

    advanceRunnerSessionState(session, 'ready');

    expect(session.state).toBe('ready');
  });
});

describe('canWorkWithRunnerSession', () => {
  test('is true only before disposal starts', () => {
    const verdicts = Object.fromEntries(
      ALL_STATES.map((state) => [state, canWorkWithRunnerSession(held(state))]),
    );

    expect(verdicts).toEqual({
      starting: true,
      ready: true,
      draining: false,
      stopped: false,
    });
  });
});

describe('resolveRunnerSessionLiveness', () => {
  test('answers ready only when an answered session still has its process', () => {
    expect(resolveRunnerSessionLiveness({ state: 'ready', processRunning: true })).toBe('ready');
    expect(resolveRunnerSessionLiveness({ state: 'starting', processRunning: true })).toBe(
      'starting',
    );
  });

  test('reports a dead process as gone whatever the session state was', () => {
    // A runner that dies while its session is still registered must not look reusable: the next
    // command reads `gone` here and starts a fresh process (ADR 0005).
    for (const state of ALL_STATES) {
      expect(resolveRunnerSessionLiveness({ state, processRunning: false })).toBe('gone');
    }
  });

  test('passes the state through while the process is running', () => {
    for (const state of ALL_STATES) {
      expect(resolveRunnerSessionLiveness({ state, processRunning: true })).toBe(state);
    }
  });
});

// The charge ledger decides whether a runner may be handed to the next daemon, so each row records
// what is still owed after one settlement step (#2681, #2965).

describe('RunnerCommandAccounting charging', () => {
  test('an unanswered charge refuses handoff', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');

    expect(charges.hasOutstandingCharges).toBe(true);
    expect(charges.hasAbandonedCharges).toBe(false);
  });

  test('a charge with no id stays owed forever', () => {
    // Nothing can name it later: the runner journals only commands that carried an id, so an
    // exchange sent without one can never be proven landed. Unreachable on the command path, where
    // every queued command is given an id; kept as the conservative outcome rather than a guess.
    const charges = new RunnerCommandAccounting();
    charges.charge(undefined);
    charges.settleAnswered(undefined);
    charges.markAbandoned(undefined);

    expect(charges.hasOutstandingCharges).toBe(true);
    expect(charges.settleTerminalEvidence(undefined)).toEqual({
      settled: false,
      refused: 'no_abandoned_charge',
    });
  });
});

describe('RunnerCommandAccounting answering', () => {
  test('settles its own charge and leaves a clean runner eligible', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.settleAnswered('cmd-a');

    expect(charges.hasOutstandingCharges).toBe(false);
  });

  test('forgives one abandoned charge sent before it', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.charge('cmd-b');
    charges.settleAnswered('cmd-b');

    // The serial queue makes B's answer evidence that the queued handling ahead of it finished.
    expect(charges.hasOutstandingCharges).toBe(false);
  });

  test('does not forgive an abandoned charge sent after it', () => {
    // A's answer says nothing about work queued behind it, so B keeps the runner on the kill path
    // even though both charges are for the same session.
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.charge('cmd-b');
    charges.markAbandoned('cmd-b');
    charges.settleAnswered('cmd-a');

    expect(charges.outstandingChargeCount).toBe(1);
    expect(charges.hasAbandonedCharges).toBe(true);
  });

  test('leaves one residue per extra abandoned exchange', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.charge('cmd-b');
    charges.markAbandoned('cmd-b');
    charges.charge('cmd-c');
    charges.settleAnswered('cmd-c');

    expect(charges.outstandingChargeCount).toBe(1);
    expect(charges.hasAbandonedCharges).toBe(true);
  });

  test("treats a late answer on an abandoned charge as that exchange's own proof", () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.charge('cmd-b');
    charges.markAbandoned('cmd-b');
    charges.settleAnswered('cmd-a');

    expect(charges.outstandingChargeCount).toBe(1);
    expect(charges.hasAbandonedCharges).toBe(true);
  });

  test('settles nothing when the id names no charge', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.settleAnswered('cmd-unknown');

    expect(charges.outstandingChargeCount).toBe(1);
  });
});

describe('RunnerCommandAccounting abandonment', () => {
  test('marks the named charge and keeps it owed', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');

    expect(charges.hasOutstandingCharges).toBe(true);
    expect(charges.hasAbandonedCharges).toBe(true);
  });

  test('marks no other command when the id holds no charge', () => {
    // A send that failed before the request carried an id reports a failure for nothing. Marking the
    // oldest charge abandoned instead would hand terminal evidence for that other command a debt to
    // discharge and put a runner whose queue is empty back on the happy path.
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-gone');

    expect(charges.hasAbandonedCharges).toBe(false);
    expect(charges.settleTerminalEvidence('cmd-a')).toEqual({
      settled: false,
      refused: 'no_abandoned_charge',
    });
    expect(charges.hasOutstandingCharges).toBe(true);
  });
});

describe('RunnerCommandAccounting terminal evidence', () => {
  test('discharges the abandoned charge it names', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');

    expect(charges.settleTerminalEvidence('cmd-a')).toEqual({
      settled: true,
      refused: undefined,
    });
    expect(charges.hasOutstandingCharges).toBe(false);
  });

  test('discharges nothing a second time', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.settleTerminalEvidence('cmd-a');

    expect(charges.settleTerminalEvidence('cmd-a')).toEqual({
      settled: false,
      refused: 'no_abandoned_charge',
    });
  });

  test("cannot consume another command's charge", () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.charge('cmd-b');
    charges.markAbandoned('cmd-b');

    charges.settleTerminalEvidence('cmd-a');

    expect(charges.outstandingChargeCount).toBe(1);
    expect(charges.hasAbandonedCharges).toBe(true);
  });

  test('leaves an exchange still being awaited charged', () => {
    // A read-only resend re-sends the same id, so both attempts share one logical command. Terminal
    // evidence discharges the abandoned attempt; the live wait keeps its own charge.
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.charge('cmd-a');

    expect(charges.settleTerminalEvidence('cmd-a').settled).toBe(true);
    expect(charges.outstandingChargeCount).toBe(1);
    expect(charges.hasAbandonedCharges).toBe(false);

    charges.settleAnswered('cmd-a');
    expect(charges.hasOutstandingCharges).toBe(false);
  });

  test('settles every abandoned attempt of a coalesced execution', () => {
    // The runner journals one execution per id, so one verdict proves every send waiting on it.
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');

    expect(charges.settleTerminalEvidence('cmd-a').settled).toBe(true);
    expect(charges.hasOutstandingCharges).toBe(false);
  });

  test('names the surviving charge when a queued answer forgave one of two', () => {
    const charges = new RunnerCommandAccounting();
    charges.charge('cmd-a');
    charges.markAbandoned('cmd-a');
    charges.charge('cmd-b');
    charges.markAbandoned('cmd-b');
    charges.charge('cmd-c');
    charges.settleAnswered('cmd-c');

    // C's answer forgave the oldest residue, so B survives and only B's own verdict discharges it.
    expect(charges.hasAbandonedCharges).toBe(true);
    expect(charges.settleTerminalEvidence('cmd-a')).toEqual({
      settled: false,
      refused: 'no_abandoned_charge',
    });
    expect(charges.settleTerminalEvidence('cmd-b').settled).toBe(true);
    expect(charges.hasOutstandingCharges).toBe(false);
  });
});
