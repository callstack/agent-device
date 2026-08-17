// The nightly XCTest lane's reporter is also its liveness check, and both halves only ever
// execute on a macOS runner at 04:30 — so they are proven here instead.

import { describe, expect, test } from 'vitest';
import {
  livenessFailure,
  MAX_FAILURE_TEXT,
  MAX_LISTED_FAILURES,
  renderSummary,
  type ResultSummary,
} from '../xctest-run-summary.ts';

function failures(count: number, text = 'assertion failed') {
  return Array.from({ length: count }, (_, index) => ({
    testName: `testCase${index}()`,
    failureText: text,
  }));
}

describe('the liveness check', () => {
  test('a run that executed no tests fails, because xcodebuild calls that success', () => {
    // The lane's whole reason to assert: a build without the unit-test compile flag, an
    // empty test plan, or a `-skip-testing:` entry that swallowed the suite all exit 0.
    const failure = livenessFailure({ result: 'Passed', totalTestCount: 0 });
    expect(failure).toContain('executed no tests');
    expect(failure).toContain('AGENT_DEVICE_XCUITEST_INCLUDE_UNIT_TESTS');
    expect(failure).toContain('-skip-testing');
  });

  test('a summary missing the count entirely is treated as no tests, not as unknown', () => {
    expect(livenessFailure({})).not.toBeNull();
  });

  test('a run that executed tests passes, red or green', () => {
    expect(livenessFailure({ totalTestCount: 153, result: 'Failed', failedTests: 9 })).toBeNull();
    expect(livenessFailure({ totalTestCount: 1, result: 'Passed' })).toBeNull();
  });
});

describe('the job summary', () => {
  const green: ResultSummary = {
    result: 'Passed',
    totalTestCount: 153,
    passedTests: 153,
    failedTests: 0,
    skippedTests: 0,
    expectedFailures: 0,
    startTime: 1000,
    finishTime: 1450,
  };

  test('leads with the headline a reader needs', () => {
    const rendered = renderSummary(green);
    expect(rendered).toContain('- result: **Passed**');
    expect(rendered).toContain('- executed: **153** (passed 153, failed 0, skipped 0');
    expect(rendered).toContain('- duration: 450s');
    expect(rendered).not.toContain('#### Failures');
  });

  test('reports an unknown duration rather than NaN when the times are absent', () => {
    expect(renderSummary({ totalTestCount: 1 })).toContain('- duration: unknown');
  });

  test('lists failures and names each one', () => {
    const rendered = renderSummary({ ...green, result: 'Failed', testFailures: failures(3) });
    expect(rendered).toContain('#### Failures');
    expect(rendered).toContain('`testCase0()`');
    expect(rendered).toContain('assertion failed');
  });

  test('caps the list, and says how many it dropped', () => {
    // The night this lane matters most is the night the failure list is longest, and the
    // job summary is capped at 1 MiB — losing the headline to the tail would be the worst
    // possible trade.
    const rendered = renderSummary({
      ...green,
      result: 'Failed',
      testFailures: failures(MAX_LISTED_FAILURES + 7),
    });
    const listed = rendered.split('\n').filter((line) => line.startsWith('- `test')).length;
    expect(listed).toBe(MAX_LISTED_FAILURES);
    expect(rendered).toContain('…and 7 more');
  });

  test('truncates one enormous failure message instead of letting it dominate', () => {
    const rendered = renderSummary({
      ...green,
      result: 'Failed',
      testFailures: failures(1, 'x'.repeat(5000)),
    });
    expect(rendered).toContain('x'.repeat(MAX_FAILURE_TEXT));
    expect(rendered).not.toContain('x'.repeat(MAX_FAILURE_TEXT + 1));
  });

  test('flattens newlines so a multi-line stack cannot forge markdown structure', () => {
    const rendered = renderSummary({
      ...green,
      result: 'Failed',
      testFailures: [{ testName: 'testX()', failureText: 'line one\n#### Injected\nline two' }],
    });
    // Markdown headings only bind at the start of a line, so flattening is what disarms
    // the injection: the text survives verbatim, but it can no longer open a section.
    expect(rendered.split('\n').filter((line) => line.startsWith('#'))).toEqual([
      '### iOS runner full XCTest suite',
      '#### Failures',
    ]);
    expect(rendered).toContain('line one #### Injected line two');
  });

  test('falls back to the identifier when a failure carries no test name', () => {
    const rendered = renderSummary({
      ...green,
      testFailures: [{ testIdentifierString: 'RunnerTests/testY()', failureText: 'boom' }],
    });
    expect(rendered).toContain('`RunnerTests/testY()`');
  });
});
