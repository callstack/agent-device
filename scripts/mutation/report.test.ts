// The report is the lane's whole product (#1457): it never gates, so a table
// that stops carrying the numbers is the lane failing silently rather than
// loudly. Both #1474 and #1475 were written from this table.
//
// Only the renderer is exercised here; every test that runs the CLI lives in
// envelope.test.ts, because a second file spawning `run.ts` would race it over
// the repo-relative lane envelope.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderReport } from './report.ts';
import { summarizeReport } from './score.ts';

const PROVENANCE = { strykerVersion: '9.6.1', configHash: 'sha256:abcdef123456' };

test('the table carries score, killed, survived, total and timeouts per kernel', () => {
  const scores = summarizeReport(
    {
      files: {
        'packages/kernel/src/errors.ts': {
          mutants: [
            { status: 'Killed' },
            { status: 'Timeout' },
            {
              status: 'Survived',
              mutatorName: 'ConditionalExpression',
              location: { start: { line: 7 } },
            },
            {
              status: 'NoCoverage',
              mutatorName: 'BooleanLiteral',
              location: { start: { line: 9 } },
            },
          ],
        },
      },
    },
    ['kernel-errors'],
  );
  const markdown = renderReport(scores, PROVENANCE);
  // Timeouts count as killed, so a score propped up by slow mutants rather than
  // assertions is only visible if the column is rendered.
  assert.match(markdown, /\| `kernel-errors` — [^|]+\| 50% \| 2 \| 2 \| 4 \| 1 \|/);
  // The surviving mutants are what a test-strengthening PR works from.
  assert.match(markdown, /- `packages\/kernel\/src\/errors\.ts:7` ConditionalExpression/);
  assert.match(markdown, /- `packages\/kernel\/src\/errors\.ts:9` BooleanLiteral/);
});

// The denominator is the report's arithmetic: counting tool-side noise would
// silently deflate every score the lane publishes. Ported from the deleted
// ratchet.test.ts, which was where this lived.
test('statuses outside the score (Ignored, CompileError, RuntimeError) leave the denominator', () => {
  const [score] = summarizeReport(
    {
      files: {
        'packages/kernel/src/errors.ts': {
          mutants: [
            { status: 'Killed' },
            { status: 'Ignored' },
            { status: 'CompileError' },
            { status: 'RuntimeError' },
          ],
        },
      },
    },
    ['kernel-errors'],
  );
  assert.equal(score?.total, 1);
  assert.equal(score?.score, 100);
});

test('a kernel with no surviving mutants lists no detail section', () => {
  const scores = summarizeReport(
    { files: { 'packages/kernel/src/errors.ts': { mutants: [{ status: 'Killed' }] } } },
    ['kernel-errors'],
  );
  const markdown = renderReport(scores, PROVENANCE);
  assert.match(markdown, /\| `kernel-errors` — [^|]+\| 100% \| 1 \| 0 \| 1 \| 0 \|/);
  assert.doesNotMatch(markdown, /^### /m);
});
