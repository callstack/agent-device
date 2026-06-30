import { test, expect } from 'vitest';
import {
  buildRunnerRequestCountBaseline,
  compareRunnerCounts,
  countRunnerRequests,
  emptyRunnerRequestCounts,
  parseDiagnosticNdjson,
  parseRunnerRequestCountBaseline,
  RUNNER_ROUND_TRIP_PHASES,
  type RunnerRequestCountBaseline,
} from '../runner-request-count.ts';

// A representative daemon `--debug` daemon.log capture: plain (non-JSON) daemon
// log lines interleaved with diagnostic ndjson, plus a stderr-prefixed line, a
// blank line, and a malformed JSON line — every one of which the tolerant parser
// must skip without throwing.
function ndjsonLine(phase: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts: '2026-06-30T00:00:00.000Z',
    level: 'info',
    phase,
    session: 'gate',
    requestId: 'req-1',
    command: 'click',
    durationMs: 12,
    ...extra,
  });
}

const SAMPLE_LOG = [
  '[daemon] started, pid 4242',
  ndjsonLine('ios_runner_readiness_preflight'),
  ndjsonLine('ios_runner_command_send', { command: 'open' }),
  '',
  ndjsonLine('ios_runner_command_send', { command: 'click' }),
  // Not a round-trip — the daemon excludes these explicitly.
  ndjsonLine('ios_runner_readiness_preflight_skipped'),
  // Unrelated phase from another subsystem.
  ndjsonLine('android_adb_shell'),
  '{ this is not valid json',
  `[agent-device][diag] ${ndjsonLine('ios_runner_command_send', { command: 'back' })}`,
  '[daemon] request complete',
].join('\n');

test('parseDiagnosticNdjson skips non-JSON, blank, malformed, and phaseless lines', () => {
  const events = parseDiagnosticNdjson(SAMPLE_LOG);
  // 5 well-formed diagnostic events (4 runner phases + 1 unrelated + 1 skipped = 6),
  // including the stderr-prefixed one; the plain log lines and bad JSON are dropped.
  expect(events.map((e) => e.phase)).toEqual([
    'ios_runner_readiness_preflight',
    'ios_runner_command_send',
    'ios_runner_command_send',
    'ios_runner_readiness_preflight_skipped',
    'android_adb_shell',
    'ios_runner_command_send',
  ]);
});

test('parseDiagnosticNdjson strips the stderr diagnostic prefix', () => {
  const events = parseDiagnosticNdjson(
    `[agent-device][diag] ${ndjsonLine('ios_runner_command_send')}`,
  );
  expect(events).toHaveLength(1);
  expect(events[0]?.phase).toBe('ios_runner_command_send');
  expect(events[0]?.command).toBe('click');
});

test('countRunnerRequests counts only the two round-trip phases (from text)', () => {
  const counts = countRunnerRequests(SAMPLE_LOG);
  expect(counts.runnerRoundTrips).toBe(4);
  expect(counts.byPhase).toEqual({
    ios_runner_command_send: 3,
    ios_runner_readiness_preflight: 1,
  });
});

test('countRunnerRequests matches the in-process counting semantics (3 round-trips)', () => {
  // Mirrors request-router-cost.test.ts: 1 preflight + 2 command_send + a skipped
  // marker + an unrelated phase => 3 runner round-trips.
  const events = parseDiagnosticNdjson(
    [
      ndjsonLine('ios_runner_readiness_preflight'),
      ndjsonLine('ios_runner_command_send'),
      ndjsonLine('ios_runner_command_send'),
      ndjsonLine('ios_runner_readiness_preflight_skipped'),
      ndjsonLine('snapshot_capture'),
    ].join('\n'),
  );
  expect(countRunnerRequests(events).runnerRoundTrips).toBe(3);
});

test('countRunnerRequests on empty input is zeroed', () => {
  expect(countRunnerRequests('')).toEqual(emptyRunnerRequestCounts());
  expect(emptyRunnerRequestCounts().runnerRoundTrips).toBe(0);
});

test('RUNNER_ROUND_TRIP_PHASES is the documented pair', () => {
  expect([...RUNNER_ROUND_TRIP_PHASES]).toEqual([
    'ios_runner_command_send',
    'ios_runner_readiness_preflight',
  ]);
});

// --- baseline parse + compare ------------------------------------------------

const ARMED_BASELINE: RunnerRequestCountBaseline = {
  scenario: 'test/integration/replays/ios/simulator/01-settings.ad',
  established: true,
  runnerRoundTrips: 4,
  byPhase: { ios_runner_command_send: 3, ios_runner_readiness_preflight: 1 },
};

test('parseRunnerRequestCountBaseline validates and ignores unknown keys', () => {
  const parsed = parseRunnerRequestCountBaseline({
    $comment: 'regenerate with --update',
    scenario: ARMED_BASELINE.scenario,
    established: true,
    runnerRoundTrips: 4,
    byPhase: { ios_runner_command_send: 3, ios_runner_readiness_preflight: 1 },
  });
  expect(parsed).toEqual(ARMED_BASELINE);
});

test('parseRunnerRequestCountBaseline treats missing/false established as unarmed', () => {
  const parsed = parseRunnerRequestCountBaseline({
    scenario: ARMED_BASELINE.scenario,
    runnerRoundTrips: 0,
    byPhase: { ios_runner_command_send: 0, ios_runner_readiness_preflight: 0 },
  });
  expect(parsed.established).toBe(false);
});

test('parseRunnerRequestCountBaseline rejects malformed payloads', () => {
  expect(() => parseRunnerRequestCountBaseline(null)).toThrow(/must be a JSON object/);
  expect(() => parseRunnerRequestCountBaseline({ byPhase: {} })).toThrow(/scenario/);
  expect(() => parseRunnerRequestCountBaseline({ scenario: 'x', runnerRoundTrips: 1 })).toThrow(
    /byPhase/,
  );
  expect(() =>
    parseRunnerRequestCountBaseline({
      scenario: 'x',
      runnerRoundTrips: -1,
      byPhase: { ios_runner_command_send: 0, ios_runner_readiness_preflight: 0 },
    }),
  ).toThrow(/non-negative integer/);
});

test('compareRunnerCounts skips assertion when the baseline is unarmed', () => {
  const unarmed = parseRunnerRequestCountBaseline({
    scenario: ARMED_BASELINE.scenario,
    established: false,
    runnerRoundTrips: 0,
    byPhase: { ios_runner_command_send: 0, ios_runner_readiness_preflight: 0 },
  });
  expect(compareRunnerCounts(unarmed, countRunnerRequests(SAMPLE_LOG))).toEqual({
    status: 'unarmed',
  });
});

test('compareRunnerCounts matches identical counts', () => {
  expect(compareRunnerCounts(ARMED_BASELINE, countRunnerRequests(SAMPLE_LOG))).toEqual({
    status: 'match',
  });
});

test('compareRunnerCounts reports per-key differences on drift', () => {
  // Drop one command_send (a runner refactor that removed a request).
  const drifted = countRunnerRequests(
    [
      ndjsonLine('ios_runner_readiness_preflight'),
      ndjsonLine('ios_runner_command_send'),
      ndjsonLine('ios_runner_command_send'),
    ].join('\n'),
  );
  const result = compareRunnerCounts(ARMED_BASELINE, drifted);
  expect(result).toEqual({
    status: 'mismatch',
    differences: [
      { key: 'runnerRoundTrips', expected: 4, actual: 3 },
      { key: 'ios_runner_command_send', expected: 3, actual: 2 },
    ],
  });
});

test('buildRunnerRequestCountBaseline arms a baseline from observed counts', () => {
  const baseline = buildRunnerRequestCountBaseline(
    ARMED_BASELINE.scenario,
    countRunnerRequests(SAMPLE_LOG),
  );
  expect(baseline).toEqual(ARMED_BASELINE);
});
