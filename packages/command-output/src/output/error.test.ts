import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { formatHumanError, type HumanErrorOptions } from './error.ts';

test('formatHumanError renders a structured cause unconditionally', () => {
  const err = new AppError(
    'COMMAND_FAILED',
    'The daemon failed to fetch the app source',
    undefined,
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    }),
  );

  const output = renderLines(err);

  assert.match(output, /Cause: ECONNREFUSED connect ECONNREFUSED 10\.0\.0\.1:443/);
});

function renderLines(err: AppError, options?: HumanErrorOptions): string {
  const { summary, body } = formatHumanError(err, options);
  return [summary, ...body].join('\n');
}

// --- ADR 0012 migration step 2: replay divergence compact text report ---

test('formatHumanError renders a compact divergence report unconditionally (not gated behind --debug)', () => {
  const err = new AppError(
    'REPLAY_DIVERGENCE',
    'Replay failed at step 2 (click "Save"): not hittable',
    {
      divergence: {
        version: 1,
        kind: 'action-failure',
        step: { index: 2, source: { path: '/tmp/flow.ad', line: 5 } },
        action: 'click "Save"',
        cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
        screen: {
          state: 'available',
          refsGeneration: 3,
          refs: [{ ref: 'e5', role: 'button', label: 'Save' }],
        },
        suggestions: [
          { selector: 'id="save"', basis: 'id', ref: 'e5', role: 'button', label: 'Save' },
        ],
        suggestionCount: 1,
        resume: { allowed: false, reason: 'resume not yet supported' },
        // ADR 0012 decision 6: always present, and must survive every
        // projection — this is the "daemon text summary" (CLI) projection.
        repairHint: 'record-and-heal',
      },
    },
  );

  const output = renderLines(err);

  assert.match(output, /Divergence at step 2 \(\/tmp\/flow\.ad:5\)/);
  assert.match(output, /Screen: 1 actionable ref\(s\) captured \(refsGeneration 3\)/);
  assert.match(output, /@e5 \[button\] "Save"/);
  assert.match(output, /Suggestions:/);
  assert.match(output, /\[id\] "Save" id="save"/);
  assert.match(output, /Repair hint: record-and-heal/);
  // Not gated behind --debug: showDetails defaults to false/undefined here.
});

// --- #2560: run-level warnings ride the failed response to the human surface ---

test('formatHumanError renders run-level warnings carried in error details', () => {
  const err = new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 2 (tapOn "Save")', {
    step: 2,
    warnings: ['Optional Maestro assertVisible skipped at line 1: no match', 7],
  });

  const output = renderLines(err);

  assert.match(
    output,
    /Error \(REPLAY_DIVERGENCE\)[\s\S]*^Warning: Optional Maestro assertVisible skipped at line 1: no match$/m,
  );
  assert.equal(output.includes('Warning: 7'), false);
});

test('formatHumanError prints no Warning lines without a warnings channel', () => {
  const err = new AppError('COMMAND_FAILED', 'tap failed');

  const output = renderLines(err);

  assert.equal(output.includes('Warning:'), false);
});

// --- #1597: AMBIGUOUS_MATCH candidates print unconditionally, capped at 5 ---

test('formatHumanError puts two or three distinguishable ambiguous candidates on the summary line', () => {
  const err = new AppError('AMBIGUOUS_MATCH', 'Selector matched 3 elements: text~="Save"', {
    matches: 3,
    refsGeneration: 7,
    candidates: ['@e2 [button] "Save"', '@e5 [button] "Save draft"', '@e9 [link] "Save as"'],
  });

  const { summary, body } = formatHumanError(err);

  // A reader that keeps one line (tail -1, head -1) still gets every ref it can act on.
  assert.match(
    summary,
    /Next: Act on one ref .*: @e2~s7 \[button\] "Save"; @e5~s7 \[button\] "Save draft"; @e9~s7 \[link\] "Save as"$/,
  );
  assert.equal(body.join('\n').includes('Candidates:'), false);
});

// Identical candidates leave nothing to choose by: naming them as the step would invite a guess.
test('formatHumanError keeps the narrowing hint when ambiguous candidates read the same', () => {
  const err = new AppError(
    'AMBIGUOUS_MATCH',
    'find matched 3 elements for text "Follow". Use a more specific locator or selector.',
    {
      matches: 3,
      candidates: ['@e2 [button] "Follow"', '@e5 [button] "Follow"', '@e9 [button] "Follow"'],
    },
  );

  const { summary, body } = formatHumanError(err);

  assert.match(summary, /Next: Multiple candidates matched\. Narrow the query/);
  assert.equal(summary.includes('Act on one ref'), false);
  assert.match(body.join('\n'), /Candidates:\n {2}@e2 \[button\] "Follow"/);
});

test('formatHumanError keeps the summary on one line when a candidate label has a newline', () => {
  const err = new AppError('AMBIGUOUS_MATCH', 'Selector matched 2 elements: text="Pay now"', {
    matches: 2,
    candidates: ['@e2 [button] "Pay\nnow"', '@e3 [link] "Pay\nnow"'],
  });

  const { summary } = formatHumanError(err);

  assert.equal(summary.includes('\n'), false);
  assert.match(summary, /@e2 \[button\] "Pay now"; @e3 \[link\] "Pay now"$/);
});

test('formatHumanError lists four or more ambiguous candidates in the body', () => {
  const candidates = [
    '@e2 [button] "A"',
    '@e3 [button] "B"',
    '@e4 [button] "C"',
    '@e5 [button] "D"',
  ];
  const err = new AppError('AMBIGUOUS_MATCH', 'Selector matched 4 elements: text="x"', {
    matches: 4,
    candidates,
    hint: 'Narrow the selector.',
  });

  const { summary, body } = formatHumanError(err);

  assert.match(summary, /Next: Narrow the selector\.$/);
  assert.match(body.join('\n'), /Candidates:\n {2}@e2 \[button\] "A"/);
});

test('formatHumanError keeps candidates of a non-ambiguity failure in the body', () => {
  const err = new AppError('COMMAND_FAILED', 'not hittable', {
    matches: 2,
    candidates: ['@e2 [button] "A"', '@e3 [button] "B"'],
    hint: 'Scroll it into view.',
  });

  const { summary, body } = formatHumanError(err);

  assert.match(summary, /Next: Scroll it into view\.$/);
  assert.match(body.join('\n'), /Candidates:/);
});

test('formatHumanError appends a "+N more" marker when candidates were capped', () => {
  const err = new AppError('AMBIGUOUS_MATCH', 'find matched 7 elements for text "Row". ...', {
    matches: 7,
    candidates: [
      '@e2 [button] "Row"',
      '@e3 [button] "Row"',
      '@e4 [button] "Row"',
      '@e5 [button] "Row"',
      '@e6 [button] "Row"',
    ],
  });

  const output = renderLines(err);

  assert.match(output, /@e6 \[button\] "Row"\n {2}\+2 more/);
});

// The device-domain resolvers (findBootedAppleSimulatorWithApp,
// -device/device-selection/dispatch-resolve) key their candidate list `devices`, so the CLI
// renders the udids the "pass --udid" hint asks for. The structured candidate
// view comes from @agent-device/kernel/errors and formatting stays local here.
test('formatHumanError lists device candidates for the device-domain resolvers', () => {
  const err = new AppError(
    'AMBIGUOUS_MATCH',
    'Multiple booted iOS simulators have com.example.app installed',
    {
      appTarget: 'com.example.app',
      devices: [
        { id: 'SIM-001', name: 'iPhone 17 Pro' },
        { id: 'SIM-002', name: 'iPhone 17' },
      ],
      hint: 'Pass --udid to select the intended simulator explicitly.',
    },
  );

  const output = renderLines(err);

  assert.match(output, /Devices:\n {2}SIM-001 {2}iPhone 17 Pro\n {2}SIM-002 {2}iPhone 17/);
  assert.equal(output.includes('[object Object]'), false);
});

test('formatHumanError shows an unavailable screen reason and omitted suggestions hint', () => {
  const err = new AppError('REPLAY_DIVERGENCE', 'Replay failed at step 1', {
    divergence: {
      version: 1,
      kind: 'action-failure',
      step: { index: 1, source: { path: '/tmp/flow.ad', line: 1 } },
      action: 'click "Save"',
      cause: { code: 'COMMAND_FAILED', message: 'not hittable' },
      screen: {
        state: 'unavailable',
        reason: 'capture-failed',
        hint: 'take a snapshot to observe the result.',
      },
      suggestions: [],
      suggestionCount: 2,
      resume: { allowed: false, reason: 'resume not yet supported' },
    },
  });

  const output = renderLines(err);

  assert.match(output, /Screen: unavailable \(capture-failed\)\. take a snapshot/);
  assert.match(output, /Suggestions: 2 available \(omitted at this response level/);
});

// --- the summary line: code, message, typed dispatch fact, Next step ---

test('formatHumanError states a possible dispatch and the observe-first step on one line', () => {
  const err = new AppError('COMMAND_FAILED', 'tap @e12: runner did not answer within 10s', {
    dispatched: 'unknown',
  });

  const { summary } = formatHumanError(err);

  assert.equal(
    summary,
    'Error (COMMAND_FAILED): tap @e12: runner did not answer within 10s. May have reached the device. Next: Run snapshot to check the screen before you retry. Read the diagnostics log for the failing step.',
  );
});

// Batch aggregation, the request ledger and replay projection can raise `dispatched` after the
// hint was resolved. The observe-first step comes from the final disclosure, not from the hint.
test('formatHumanError puts the observe-first step before a hint resolved under an earlier verdict', () => {
  const err = new AppError('DEVICE_IN_USE', 'Batch failed at step 2 (press): device busy', {
    hint: 'Retry once the device frees up.',
    dispatched: 'unknown',
  });

  assert.match(
    formatHumanError(err).summary,
    /May have reached the device\. Next: Run snapshot to check the screen before you retry\. Retry once the device frees up\.$/,
  );
});

test('formatHumanError states a proven non-dispatch and says nothing for an unclassified one', () => {
  const refused = formatHumanError(
    new AppError('SESSION_NOT_FOUND', 'No active session.', { dispatched: 'no' }),
  );
  assert.match(
    refused.summary,
    /^Error \(SESSION_NOT_FOUND\): No active session\. Not dispatched\. Next: Run open/,
  );

  const unclassified = formatHumanError(new AppError('COMMAND_FAILED', 'helper failed'));
  assert.equal(
    unclassified.summary,
    'Error (COMMAND_FAILED): helper failed. Next: Read the diagnostics log for the failing step.',
  );
});

test('formatHumanError prints the log path and never the diagnostic id', () => {
  const err = new AppError('COMMAND_FAILED', 'boom', {
    diagnosticId: 'diag-123',
    logPath: '/tmp/diag.ndjson',
  });

  const output = renderLines(err);

  assert.match(output, /^Log: \/tmp\/diag\.ndjson$/m);
  assert.equal(output.includes('diag-123'), false);
});

test('formatHumanError reports a remote record it could not fetch as an unavailable log', () => {
  const err = new AppError('COMMAND_FAILED', 'boom', { logPathUnavailable: 'fetch refused' });

  assert.match(renderLines(err), /^Log: unavailable \(fetch refused\)$/m);
});

test('formatHumanError keeps the summary on one bounded line and the full message in the body', () => {
  const longMessage = `first line\nsecond line ${'x'.repeat(400)}`;
  const { summary, body } = formatHumanError(new AppError('COMMAND_FAILED', longMessage));

  assert.equal(summary.includes('\n'), false);
  assert.match(summary, /^Error \(COMMAND_FAILED\): first line second line x+…/);
  assert.ok(summary.length < 600);
  assert.equal(body[0], `Message: ${longMessage}`);
});

test('formatHumanError adds the command synopsis to an INVALID_ARGS Next step', () => {
  const synopsis = 'agent-device press <x y|@ref|selector>';
  const generic = formatHumanError(new AppError('INVALID_ARGS', 'Missing target.'), { synopsis });
  assert.match(
    generic.summary,
    /Next: Fix the command arguments; run help <command> for usage\. Usage: agent-device press <x y\|@ref\|selector>$/,
  );

  const specific = formatHumanError(
    new AppError('INVALID_ARGS', 'Bad pair.', { hint: 'Use --serial for Android.' }),
    { synopsis },
  );
  assert.match(specific.summary, /Next: Use --serial for Android\. Usage: agent-device press /);

  const notArgs = formatHumanError(new AppError('COMMAND_FAILED', 'boom'), { synopsis });
  assert.equal(notArgs.summary.includes('Usage:'), false);
});
