import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkSeams, findSeamMatches } from './model.ts';

test('findSeamMatches finds an unapproved optional typeof property with its line number', () => {
  const matches = findSeamMatches([
    { path: 'a.ts', source: 'type T = {\n  dispatch?: typeof dispatchCommand;\n};\n' },
  ]);
  assert.deepEqual(matches, [
    {
      file: 'a.ts',
      line: 2,
      field: 'dispatch',
      target: 'dispatchCommand',
      text: 'dispatch?: typeof dispatchCommand;',
      approvalReason: null,
    },
  ]);
});

test('findSeamMatches ignores a required (non-optional) field', () => {
  const matches = findSeamMatches([
    { path: 'a.ts', source: 'type T = { dispatch: typeof dispatchCommand };' },
  ]);
  assert.deepEqual(matches, []);
});

test('findSeamMatches finds a bare optional function parameter, not just object-type fields', () => {
  const matches = findSeamMatches([
    { path: 'a.ts', source: 'function f(dispatch?: typeof dispatchCommand) {}\n' },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.field, 'dispatch');
  assert.equal(matches[0]?.target, 'dispatchCommand');
});

// AST-based matching finds this for free — no multiline-specific handling needed, unlike a
// text-based scan (PR #2006 review, round 2).
test('findSeamMatches finds a declaration whose `?:` and `typeof` land on different lines', () => {
  const matches = findSeamMatches([
    { path: 'a.ts', source: 'type T = {\n  dispatch?:\n    typeof dispatchCommand;\n};\n' },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.field, 'dispatch');
  assert.equal(matches[0]?.target, 'dispatchCommand');
});

test('findSeamMatches attaches an immediately-preceding di-seam-approved comment', () => {
  const matches = findSeamMatches([
    {
      path: 'a.ts',
      source:
        'type T = {\n  // di-seam-approved: legitimate, reviewed\n  dispatch?: typeof dispatchCommand;\n};\n',
    },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.approvalReason, 'legitimate, reviewed');
});

test('findSeamMatches joins a multi-line di-seam-approved comment block into one reason', () => {
  const matches = findSeamMatches([
    {
      path: 'a.ts',
      source:
        'type T = {\n  // di-seam-approved: first line of the reason\n  // second line of the reason\n  dispatch?: typeof dispatchCommand;\n};\n',
    },
  ]);
  assert.equal(matches[0]?.approvalReason, 'first line of the reason second line of the reason');
});

test('findSeamMatches does not treat a marker on an earlier, unrelated field as approving this one', () => {
  const matches = findSeamMatches([
    {
      path: 'a.ts',
      source:
        'type T = {\n  // di-seam-approved: approves otherField only\n  otherField: string;\n  dispatch?: typeof dispatchCommand;\n};\n',
    },
  ]);
  assert.equal(matches.length, 1);
  assert.equal(matches[0]?.field, 'dispatch');
  assert.equal(matches[0]?.approvalReason, null);
});

test('findSeamMatches requires the marker text itself, not just a nearby comment', () => {
  const matches = findSeamMatches([
    {
      path: 'a.ts',
      source:
        'type T = {\n  // just a plain comment, not a marker\n  dispatch?: typeof dispatchCommand;\n};\n',
    },
  ]);
  assert.equal(matches[0]?.approvalReason, null);
});

// PR #2006 review: a bare marker with no reason is a bypass, not a review — must not approve.
test('findSeamMatches rejects a di-seam-approved marker with no reason text', () => {
  const matches = findSeamMatches([
    {
      path: 'a.ts',
      source: 'type T = {\n  // di-seam-approved:\n  dispatch?: typeof dispatchCommand;\n};\n',
    },
  ]);
  assert.equal(matches[0]?.approvalReason, null);
});

test('findSeamMatches rejects a di-seam-approved marker whose reason is only whitespace', () => {
  const matches = findSeamMatches([
    {
      path: 'a.ts',
      source: 'type T = {\n  // di-seam-approved:   \n  dispatch?: typeof dispatchCommand;\n};\n',
    },
  ]);
  assert.equal(matches[0]?.approvalReason, null);
});

test('checkSeams flags a declaration whose only marker has no reason text', () => {
  const matches = findSeamMatches([
    {
      path: 'src/x.ts',
      source: 'type T = {\n  // di-seam-approved:\n  fetchImpl?: typeof fetch;\n};\n',
    },
  ]);
  const { violations } = checkSeams(matches);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.field, 'fetchImpl');
});

test('checkSeams passes an approved match and flags an unapproved one', () => {
  const matches = findSeamMatches([
    {
      path: 'src/x.ts',
      source:
        'type T = {\n  // di-seam-approved: reviewed\n  fetchImpl?: typeof fetch;\n  dispatch?: typeof dispatchCommand;\n};\n',
    },
  ]);
  const { violations } = checkSeams(matches);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.field, 'dispatch');
});

// This is the exact failure mode PR #2006's review flagged in the name-based version: approving
// one `fetchImpl?: typeof fetch` must not silently approve a second, different one.
test('checkSeams flags a second, unmarked occurrence of an approved field/target pair', () => {
  const matches = findSeamMatches([
    {
      path: 'src/x.ts',
      source:
        'type T = {\n  // di-seam-approved: reviewed\n  fetchImpl?: typeof fetch;\n};\ntype U = {\n  fetchImpl?: typeof fetch;\n};\n',
    },
  ]);
  const { violations } = checkSeams(matches);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]?.line, 6);
});

// PR #2006 review, round 3: a global positional table breaks on any unrelated line shift. A
// code-local marker has nothing to resync — reordering unrelated declarations around an approved
// one must not affect it.
test('checkSeams stays passing when unrelated code is inserted above an approved declaration', () => {
  const before = findSeamMatches([
    {
      path: 'src/x.ts',
      source: 'type T = {\n  // di-seam-approved: reviewed\n  fetchImpl?: typeof fetch;\n};\n',
    },
  ]);
  const after = findSeamMatches([
    {
      path: 'src/x.ts',
      source:
        '// an unrelated new import or declaration lands here\nconst unrelated = 1;\n\ntype T = {\n  // di-seam-approved: reviewed\n  fetchImpl?: typeof fetch;\n};\n',
    },
  ]);
  assert.deepEqual(checkSeams(before).violations, []);
  assert.deepEqual(checkSeams(after).violations, []);
  assert.notEqual(before[0]?.line, after[0]?.line);
});
