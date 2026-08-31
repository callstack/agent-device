import assert from 'node:assert/strict';
import { test } from 'vitest';
import { CASES } from '../help-conformance-cases.mjs';
import type { CapturedSample } from '../help-conformance-sample-outputs.mjs';
import * as samples from '../help-conformance-sample-outputs.mjs';
import { SAMPLE_PRODUCERS } from './help-conformance-sample-producers.ts';
import {
  defaultHintForCode,
  KNOWN_APP_ERROR_CODES,
  retriableForErrorCode,
} from '@agent-device/kernel/errors';

// "What enumerates N" for the error surface. The benchmark's recovery quizzes
// (a pinned rendered error plus "what command runs next?") are keyed to the
// error registry itself, so the two error-side policies cannot drift from the
// cases silently:
//   - a code retriableForErrorCode classifies is one an agent is told to retry,
//     so the bench must show whether a model actually recovers from it;
//   - a code with no specific defaultHintForCode entry falls back to generic
//     "retry with --debug" guidance, which is a decision, not a default.
// Uncovered codes need a named waiver below, and a waiver fails once it goes
// stale — the same shape as the help-topic gate.

/** Recovery-quiz waivers, keyed by error code: why the code is unbenchmarked. */
const WAIVED_RECOVERY_QUIZ_CODES: Record<string, string> = {};

/**
 * Codes that intentionally resolve the generic fallback hint instead of a
 * code-specific one, keyed by code with the reason the generic text is right.
 */
const WAIVED_GENERIC_HINT_CODES: Record<string, string> = {
  COMMAND_FAILED:
    'Catch-all wrap of an underlying failure: the specific "what failed" lives in the message, so the generic diagnostics guidance IS its recovery step.',
};

// Human error rendering (src/commands/output/error.ts printHumanError) opens with
// `Error (CODE): message`, so any rendered error text names its own code.
const RENDERED_ERROR_CODE = /(?:^|\n)Error \(([A-Z_]+)\):/g;

type RecoveryCase = {
  id: string;
  task: string;
  expectations?: string[];
  matchers?: { id: string; pattern: RegExp }[];
  forbidden?: { id: string; pattern: RegExp }[];
  recovery: { code: string; sample: CapturedSample };
};

function renderedErrorCodes(text: string): string[] {
  return [...`\n${text}`.matchAll(RENDERED_ERROR_CODE)].map((match) => match[1]!);
}

/** The cases that declare themselves recovery quizzes (see the cases module). */
const RECOVERY_CASES: RecoveryCase[] = CASES.filter(
  (testCase: { recovery?: unknown }): testCase is RecoveryCase => testCase.recovery !== undefined,
);

const QUIZZED_CODES = new Set(RECOVERY_CASES.map((testCase) => testCase.recovery.code));

test('every code with a retriability verdict has a recovery quiz or an explicit waiver', () => {
  const classified = KNOWN_APP_ERROR_CODES.filter(
    (code) => retriableForErrorCode(code) !== undefined,
  );
  assert.ok(classified.length > 0, 'retriableForErrorCode classifies at least one code');
  const uncovered = classified.filter(
    (code) => !QUIZZED_CODES.has(code) && !(code in WAIVED_RECOVERY_QUIZ_CODES),
  );
  assert.deepEqual(
    uncovered,
    [],
    'a code retriableForErrorCode classifies needs a recovery-quiz case in scripts/help-conformance-cases.mjs (declaring recovery: { code, sample }) or a waiver above',
  );
});

test('retriability cannot be claimed for a code outside the enumeration', () => {
  // Otherwise a new retriable code could be classified in production and still
  // escape the coverage gate above by never entering KNOWN_APP_ERROR_CODES.
  for (const unenumerated of ['RUNNER_BUSY', 'DEVICE_IN_USE_SOON', 'device_in_use', '']) {
    assert.equal(
      retriableForErrorCode(unenumerated),
      undefined,
      `"${unenumerated}" is not in KNOWN_APP_ERROR_CODES, so it must not carry a retriability verdict — add it to the enumeration (and quiz it) instead`,
    );
  }
});

test('recovery-quiz waivers only name real, classified, unquizzed codes', () => {
  const known = new Set<string>(KNOWN_APP_ERROR_CODES);
  for (const [code, reason] of Object.entries(WAIVED_RECOVERY_QUIZ_CODES)) {
    assert.ok(known.has(code), `waived code "${code}" no longer exists — remove the waiver`);
    assert.ok(
      retriableForErrorCode(code) !== undefined,
      `waived code "${code}" is no longer classified by retriableForErrorCode — remove the waiver`,
    );
    assert.ok(
      !QUIZZED_CODES.has(code),
      `waived code "${code}" now has a recovery quiz — remove the waiver`,
    );
    assert.ok(reason.trim().length > 0, `waiver for "${code}" needs a reason`);
  }
});

test('every recovery case quizzes a real code through the pinned sample that renders it', () => {
  const known = new Set<string>(KNOWN_APP_ERROR_CODES);
  const exported = new Map<CapturedSample, string>(
    Object.entries(samples)
      .filter((entry): entry is [string, CapturedSample] => typeof entry[1] === 'object')
      .map(([name, sample]) => [sample, name]),
  );
  for (const testCase of RECOVERY_CASES) {
    const { code, sample } = testCase.recovery;
    assert.ok(
      known.has(code),
      `case "${testCase.id}" claims recovery from "${code}", which is not in KNOWN_APP_ERROR_CODES — a renamed or invented code`,
    );
    assert.ok(
      exported.has(sample),
      `case "${testCase.id}" must quote a sample exported from scripts/help-conformance-sample-outputs.mjs, never an inline literal`,
    );
    assert.deepEqual(
      renderedErrorCodes(sample.output),
      [code],
      `case "${testCase.id}" declares recovery from "${code}" but its sample renders a different error`,
    );
    assert.equal(
      testCase.task.split(samples.sampleText(sample)).length,
      2,
      `case "${testCase.id}" must quote ${exported.get(sample)} verbatim, exactly once`,
    );
  }
});

test('a recovery case scores the recovery command, not just plan validity', () => {
  for (const testCase of RECOVERY_CASES) {
    assert.ok(
      testCase.expectations?.includes('validPlanCommands'),
      `case "${testCase.id}" must expect validPlanCommands`,
    );
    // Without these, "recovery" would be satisfied by any parseable plan — the
    // point of an error quiz is which next command the error's hint implies,
    // and which retry the error rules out.
    assert.ok(
      (testCase.matchers ?? []).length > 0,
      `recovery case "${testCase.id}" needs at least one matcher asserting the recovery command`,
    );
    assert.ok(
      (testCase.forbidden ?? []).length > 0,
      `recovery case "${testCase.id}" needs at least one forbidden pattern for the failure mode this error rules out`,
    );
  }
});

test('no case quotes rendered error text outside a declared pinned sample', () => {
  for (const testCase of CASES as {
    id: string;
    task: string;
    recovery?: RecoveryCase['recovery'];
  }[]) {
    const pinned = testCase.recovery ? samples.sampleText(testCase.recovery.sample) : undefined;
    const outsidePinned = pinned ? testCase.task.split(pinned).join('\n') : testCase.task;
    assert.deepEqual(
      renderedErrorCodes(outsidePinned),
      [],
      `case "${testCase.id}" quotes rendered error text that is not part of its declared pinned sample — quoted output must come from scripts/help-conformance-sample-outputs.mjs, never hand-transcribed`,
    );
    assert.doesNotMatch(
      outsidePinned,
      /(?:^|\n)Hint: /,
      `case "${testCase.id}" quotes a rendered error hint outside its declared pinned sample`,
    );
  }
});

test('every captured sample is rebuilt through a real producer', () => {
  const pinned = new Set(SAMPLE_PRODUCERS.map((producer) => producer.sample));
  for (const [name, sample] of Object.entries(samples)) {
    if (typeof sample !== 'object') continue;
    assert.ok(
      pinned.has(sample),
      `sample ${name} has no entry in help-conformance-sample-producers.ts — captured output must be rebuilt through the real producer, never trusted as a transcription`,
    );
  }
});

test('every error code resolves a hint, specific or explicitly waived as generic', () => {
  // An unlisted code falls through defaultHintForCode's default branch, so the
  // fallback text identifies codes with no entry of their own.
  const genericHint = defaultHintForCode('NOT_A_REAL_ERROR_CODE');
  assert.ok(genericHint && genericHint.length > 0, 'the fallback hint must not be empty');
  const unspecific: string[] = [];
  for (const code of KNOWN_APP_ERROR_CODES) {
    const hint = defaultHintForCode(code);
    assert.ok(hint && hint.trim().length > 0, `code "${code}" resolves an empty hint`);
    if (hint === genericHint && !(code in WAIVED_GENERIC_HINT_CODES)) unspecific.push(code);
  }
  assert.deepEqual(
    unspecific,
    [],
    'a new error code needs its own defaultHintForCode entry (errors say how to recover) or a generic-hint waiver above',
  );
});

test('generic-hint waivers only name real codes that still resolve the generic hint', () => {
  const known = new Set<string>(KNOWN_APP_ERROR_CODES);
  const genericHint = defaultHintForCode('NOT_A_REAL_ERROR_CODE');
  for (const [code, reason] of Object.entries(WAIVED_GENERIC_HINT_CODES)) {
    assert.ok(known.has(code), `waived code "${code}" no longer exists — remove the waiver`);
    assert.equal(
      defaultHintForCode(code),
      genericHint,
      `waived code "${code}" now has a code-specific hint — remove the waiver`,
    );
    assert.ok(reason.trim().length > 0, `waiver for "${code}" needs a reason`);
  }
});
