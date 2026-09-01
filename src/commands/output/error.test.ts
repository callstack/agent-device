import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { printHumanError } from './error.ts';

test('printHumanError renders a structured cause unconditionally', async () => {
  const err = new AppError(
    'COMMAND_FAILED',
    'The daemon failed to fetch the app source',
    undefined,
    Object.assign(new Error('connect ECONNREFUSED 10.0.0.1:443'), {
      code: 'ECONNREFUSED',
    }),
  );

  const output = await captureStderr(() => printHumanError(err));

  assert.match(output, /Cause: ECONNREFUSED connect ECONNREFUSED 10\.0\.0\.1:443/);
});

async function captureStderr(run: () => void | Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let output = '';
  (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
    chunk: unknown,
  ) => {
    output += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return output;
}

// --- ADR 0012 migration step 2: replay divergence compact text report ---

test('printHumanError renders a compact divergence report unconditionally (not gated behind --debug)', async () => {
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

  const output = await captureStderr(() => printHumanError(err));

  assert.match(output, /Divergence at step 2 \(\/tmp\/flow\.ad:5\)/);
  assert.match(output, /Screen: 1 actionable ref\(s\) captured \(refsGeneration 3\)/);
  assert.match(output, /@e5 \[button\] "Save"/);
  assert.match(output, /Suggestions:/);
  assert.match(output, /\[id\] "Save" id="save"/);
  assert.match(output, /Repair hint: record-and-heal/);
  // Not gated behind --debug: showDetails defaults to false/undefined here.
});

// --- #1597: AMBIGUOUS_MATCH candidates print unconditionally, capped at 5 ---

test('printHumanError lists AMBIGUOUS_MATCH candidates unconditionally, not gated behind --debug', async () => {
  const err = new AppError(
    'AMBIGUOUS_MATCH',
    'find matched 3 elements for text "Follow". Use a more specific locator or selector.',
    {
      locator: 'text',
      query: 'Follow',
      matches: 3,
      candidates: ['@e2 [button] "Follow"', '@e5 [button] "Follow"', '@e9 [button] "Follow"'],
    },
  );

  // This is the exact old-message shape the bug reported: the human render
  // used to stop at "Error (...): ...\nHint: ...", so an agent reading it had
  // no @ref to act on. Asserting the candidate lines appear proves this red
  // against that shape (it would fail before candidate views were wired into
  // printHumanError).
  const output = await captureStderr(() => printHumanError(err));

  assert.match(output, /^Error \(AMBIGUOUS_MATCH\): find matched 3 elements/);
  assert.match(
    output,
    /Candidates:\n {2}@e2 \[button\] "Follow"\n {2}@e5 \[button\] "Follow"\n {2}@e9 \[button\] "Follow"/,
  );
  // 3 candidates for 3 matches: nothing was capped, so no "+N more" marker.
  assert.equal(/\+\d+ more/.test(output), false);
  // Not gated behind --debug: showDetails defaults to false/undefined here.
});

test('printHumanError appends a "+N more" marker when candidates were capped', async () => {
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

  const output = await captureStderr(() => printHumanError(err));

  assert.match(output, /@e6 \[button\] "Row"\n {2}\+2 more/);
});

// The device-domain resolvers (findBootedAppleSimulatorWithApp,
// src/core/dispatch-resolve.ts) key their candidate list `devices`, so the CLI
// renders the udids the "pass --udid" hint asks for. The structured candidate
// view comes from @agent-device/kernel/errors and formatting stays local here.
test('printHumanError lists device candidates for the device-domain resolvers', async () => {
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

  const output = await captureStderr(() => printHumanError(err));

  assert.match(output, /Devices:\n {2}SIM-001 {2}iPhone 17 Pro\n {2}SIM-002 {2}iPhone 17/);
  assert.equal(output.includes('[object Object]'), false);
});

test('printHumanError shows an unavailable screen reason and omitted suggestions hint', async () => {
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

  const output = await captureStderr(() => printHumanError(err));

  assert.match(output, /Screen: unavailable \(capture-failed\)\. take a snapshot/);
  assert.match(output, /Suggestions: 2 available \(omitted at this response level/);
});
