import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stripConventionalSubject } from './subject.ts';

test('strips the conventional-commit prefix with or without a scope', () => {
  assert.equal(stripConventionalSubject('feat(capture-kit): add the thing (#12)'), 'add the thing');
  assert.equal(stripConventionalSubject('fix: the thing'), 'the thing');
  assert.equal(stripConventionalSubject('refactor(daemon)!: split it'), 'split it');
});

test('strips every trailing pull-request reference and nothing else', () => {
  assert.equal(
    stripConventionalSubject('refactor: collapse ios/macos into apple (#979) (#1002)'),
    'collapse ios/macos into apple',
  );
  assert.equal(stripConventionalSubject('chore: bump (#1) again'), 'bump (#1) again');
});

test('leaves a plain subject alone', () => {
  assert.equal(stripConventionalSubject("Merge branch 'topic'"), "Merge branch 'topic'");
  assert.equal(stripConventionalSubject('  spaced  '), 'spaced');
});
