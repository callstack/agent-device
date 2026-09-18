import { describe, expect, test } from 'vitest';
import {
  advanceRunnerSessionState,
  canWorkWithRunnerSession,
  resolveRunnerSessionLiveness,
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
