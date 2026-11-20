import assert from 'node:assert/strict';
import { test } from 'vitest';
import { pinElementMatchCandidateLine } from '../snapshot-lines.ts';

// A printed candidate must carry the stamp of the epoch the caller will face,
// or pasting it earns an immediate superseded refusal. The grammar is one
// implementation for the producer, the daemon issuance seam, and the CLI
// renderer; these tests pin that one answer.

test('pinElementMatchCandidateLine pins a bare candidate ref', () => {
  assert.equal(
    pinElementMatchCandidateLine('@e2 [button] "Deploy"', 750596),
    '@e2~s750596 [button] "Deploy"',
  );
});

test('pinElementMatchCandidateLine re-pins a candidate born stamped at an earlier epoch', () => {
  assert.equal(
    pinElementMatchCandidateLine('@e2~s750595 [button] "Deploy"', 750596),
    '@e2~s750596 [button] "Deploy"',
  );
});

test('pinElementMatchCandidateLine re-pins the ref without touching later @tokens in the line', () => {
  assert.equal(
    pinElementMatchCandidateLine('@e3 [text-field] "name @e9"', 42),
    '@e3~s42 [text-field] "name @e9"',
  );
});

test('pinElementMatchCandidateLine returns a line without a leading ref as is', () => {
  assert.equal(pinElementMatchCandidateLine('[button] "no ref"', 42), '[button] "no ref"');
});
