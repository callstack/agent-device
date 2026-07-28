import fs from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'vitest';
import { CASES } from '../help-conformance-cases.mjs';
import type { CapturedSample } from '../help-conformance-sample-outputs.mjs';
import * as samples from '../help-conformance-sample-outputs.mjs';
import {
  defaultHintForCode,
  KNOWN_APP_ERROR_CODES,
  retriableForErrorCode,
} from '../../src/kernel/errors.ts';

// "What enumerates N" for the error surface. The benchmark's recovery quizzes
// (a captured `Error (CODE)` output plus "what runs next?") are keyed to the
// error registry itself, so the two error-side policies cannot drift from the
// cases silently:
//   - a code `retriableForErrorCode` classifies is one an agent is told to
//     retry, so the bench must show whether a model actually recovers from it;
//   - a code with no specific `defaultHintForCode` entry falls back to generic
//     "retry with --debug" guidance, which is a decision, not a default.
// Uncovered codes need a named waiver below, and a waiver fails once it goes
// stale — the same shape as the help-topic gate.

const PINNING_TEST_FILE = 'help-conformance-sample-outputs.test.ts';

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

// Human error rendering (src/utils/output.ts printHumanError) opens with
// `Error (CODE): message`, so a quoted error sample names its own code.
const QUOTED_ERROR_CODE = /(?:^|\n)Error \(([A-Z_]+)\):/g;

const CAPTURED_SAMPLES: [string, CapturedSample][] = Object.entries(samples).filter(
  (entry): entry is [string, CapturedSample] => typeof entry[1] === 'object' && entry[1] !== null,
);

function quotedErrorCodes(text: string): string[] {
  return [...text.matchAll(QUOTED_ERROR_CODE)].map((match) => match[1]!);
}

/** Error codes an agent is quizzed on recovering from, derived from the cases. */
function quizzedErrorCodes(): Set<string> {
  return new Set(CASES.flatMap((testCase) => quotedErrorCodes(testCase.task)));
}

test('every code with a retriability verdict has a recovery quiz or an explicit waiver', () => {
  const quizzed = quizzedErrorCodes();
  const classified = KNOWN_APP_ERROR_CODES.filter(
    (code) => retriableForErrorCode(code) !== undefined,
  );
  assert.ok(classified.length > 0, 'retriableForErrorCode classifies at least one code');
  const uncovered = classified.filter(
    (code) => !quizzed.has(code) && !(code in WAIVED_RECOVERY_QUIZ_CODES),
  );
  assert.deepEqual(
    uncovered,
    [],
    'a code retriableForErrorCode classifies needs a recovery-quiz case in scripts/help-conformance-cases.mjs (quoting a pinned sample) or a waiver above',
  );
});

test('recovery-quiz waivers only name real, classified, unquizzed codes', () => {
  const known = new Set<string>(KNOWN_APP_ERROR_CODES);
  const quizzed = quizzedErrorCodes();
  for (const [code, reason] of Object.entries(WAIVED_RECOVERY_QUIZ_CODES)) {
    assert.ok(known.has(code), `waived code "${code}" no longer exists — remove the waiver`);
    assert.ok(
      retriableForErrorCode(code) !== undefined,
      `waived code "${code}" is no longer classified by retriableForErrorCode — remove the waiver`,
    );
    assert.ok(
      !quizzed.has(code),
      `waived code "${code}" now has a recovery quiz — remove the waiver`,
    );
    assert.ok(reason.trim().length > 0, `waiver for "${code}" needs a reason`);
  }
});

test('every quiz-quoted error code is a real error code', () => {
  const known = new Set<string>(KNOWN_APP_ERROR_CODES);
  for (const testCase of CASES) {
    for (const code of quotedErrorCodes(testCase.task)) {
      assert.ok(
        known.has(code),
        `case "${testCase.id}" quotes error code "${code}", which is not in KNOWN_APP_ERROR_CODES — a renamed or invented code`,
      );
    }
  }
});

test('every quiz-quoted error output comes from a pinned sample, never hand-transcribed', () => {
  for (const testCase of CASES) {
    for (const code of quotedErrorCodes(testCase.task)) {
      const source = CAPTURED_SAMPLES.find(
        ([, sample]) =>
          quotedErrorCodes(`\n${sample.output}`).includes(code) &&
          testCase.task.includes(samples.sampleText(sample)),
      );
      assert.ok(
        source,
        `case "${testCase.id}" quotes ${code} output that is not a verbatim sample from scripts/help-conformance-sample-outputs.mjs — quoted output must be pinned to its real producer, never hand-transcribed`,
      );
    }
  }
});

test('every captured sample is exercised by the sample-outputs pinning test', () => {
  const pinningTest = fs.readFileSync(join(import.meta.dirname, PINNING_TEST_FILE), 'utf8');
  for (const [name] of CAPTURED_SAMPLES) {
    assert.match(
      pinningTest,
      new RegExp(`\\b${name}\\b`),
      `sample ${name} is not referenced by ${PINNING_TEST_FILE} — rebuild it through the real producer instead of trusting the transcription`,
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
