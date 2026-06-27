import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseWaitPositionals as parseWaitArgs } from '../../../core/wait-positionals.ts';
import { parseTimeout } from '../../../utils/parse-timeout.ts';

// --- parseTimeout ---

test('parseTimeout parses integer string', () => {
  assert.equal(parseTimeout('500'), 500);
});

test('parseTimeout parses zero', () => {
  assert.equal(parseTimeout('0'), 0);
});

test('parseTimeout returns null for non-numeric string', () => {
  assert.equal(parseTimeout('abc'), null);
});

test('parseTimeout returns null for Infinity', () => {
  assert.equal(parseTimeout('Infinity'), null);
});

// --- parseWaitArgs ---

test('parseWaitArgs returns null for empty args', () => {
  assert.equal(parseWaitArgs([]), null);
});

test('parseWaitArgs returns sleep for numeric first arg', () => {
  const result = parseWaitArgs(['500']);
  assert.deepEqual(result, { kind: 'sleep', durationMs: 500 });
});

test('parseWaitArgs returns sleep for zero', () => {
  const result = parseWaitArgs(['0']);
  assert.deepEqual(result, { kind: 'sleep', durationMs: 0 });
});

test('parseWaitArgs parses text keyword with label', () => {
  const result = parseWaitArgs(['text', 'Loading']);
  assert.deepEqual(result, { kind: 'text', text: 'Loading', timeoutMs: null });
});

test('parseWaitArgs parses text keyword with timeout', () => {
  const result = parseWaitArgs(['text', 'Loading', '5000']);
  assert.deepEqual(result, { kind: 'text', text: 'Loading', timeoutMs: 5000 });
});

test('parseWaitArgs parses text keyword with multi-word and timeout', () => {
  const result = parseWaitArgs(['text', 'Sign', 'In', '3000']);
  assert.deepEqual(result, { kind: 'text', text: 'Sign In', timeoutMs: 3000 });
});

test('parseWaitArgs parses text keyword with multi-word and no timeout', () => {
  const result = parseWaitArgs(['text', 'Sign', 'In']);
  assert.deepEqual(result, { kind: 'text', text: 'Sign In', timeoutMs: null });
});

test('parseWaitArgs text keyword alone yields empty text', () => {
  const result = parseWaitArgs(['text']);
  assert.deepEqual(result, { kind: 'text', text: '', timeoutMs: null });
});

test('parseWaitArgs parses ref', () => {
  const result = parseWaitArgs(['@e3']);
  assert.deepEqual(result, { kind: 'ref', rawRef: '@e3', timeoutMs: null });
});

test('parseWaitArgs parses ref with timeout', () => {
  const result = parseWaitArgs(['@e3', '5000']);
  assert.deepEqual(result, { kind: 'ref', rawRef: '@e3', timeoutMs: 5000 });
});

test('parseWaitArgs parses ref with non-numeric trailing arg as no timeout', () => {
  const result = parseWaitArgs(['@e3', 'abc']);
  assert.deepEqual(result, { kind: 'ref', rawRef: '@e3', timeoutMs: null });
});

test('parseWaitArgs parses bare text', () => {
  const result = parseWaitArgs(['Hello']);
  assert.deepEqual(result, { kind: 'text', text: 'Hello', timeoutMs: null });
});

test('parseWaitArgs parses bare text with timeout', () => {
  const result = parseWaitArgs(['Hello', '5000']);
  assert.deepEqual(result, { kind: 'text', text: 'Hello', timeoutMs: 5000 });
});

test('parseWaitArgs parses selector expression', () => {
  const result = parseWaitArgs(['id=login_email']);
  assert.ok(result);
  assert.equal(result.kind, 'selector');
  if (result.kind === 'selector') {
    assert.equal(result.selectorExpression, 'id=login_email');
    assert.equal(result.timeoutMs, null);
  }
});

test('parseWaitArgs parses selector expression with timeout', () => {
  const result = parseWaitArgs(['id=login_email', '5000']);
  assert.ok(result);
  assert.equal(result.kind, 'selector');
  if (result.kind === 'selector') {
    assert.equal(result.selectorExpression, 'id=login_email');
    assert.equal(result.timeoutMs, 5000);
  }
});

test('parseWaitArgs falls back to text when selector-like token is invalid', () => {
  const result = parseWaitArgs(['foo=bar', '5000']);
  assert.deepEqual(result, { kind: 'text', text: 'foo=bar', timeoutMs: 5000 });
});

test('parseWaitArgs parses bare multi-word text', () => {
  const result = parseWaitArgs(['Sign', 'In']);
  assert.deepEqual(result, { kind: 'text', text: 'Sign In', timeoutMs: null });
});

test('parseWaitArgs parses bare multi-word text with timeout', () => {
  const result = parseWaitArgs(['Sign', 'In', '3000']);
  assert.deepEqual(result, { kind: 'text', text: 'Sign In', timeoutMs: 3000 });
});

test('parseWaitArgs text keyword with non-numeric trailing leaves timeoutMs null', () => {
  const result = parseWaitArgs(['text', 'Loading', 'abc']);
  assert.deepEqual(result, { kind: 'text', text: 'Loading abc', timeoutMs: null });
});
