// The selector-command argument rules live here because R2 (commands-floor) forbids the
// daemon from importing the command surface, so a rule shared by both can only be stated
// below both. These tests pin the rules themselves; the surfaces' own tests still cover
// how each one reports a refusal.
import { test, expect } from 'vitest';
import {
  checkElementTargetArgs,
  checkGetFormat,
  checkIsArgs,
  checkWaitText,
  IS_TEXT_VALUE_REQUIRED_MESSAGE,
  SELECTOR_EXPRESSION_REQUIRED_MESSAGE,
} from './arguments.ts';
import { checkFindArgs } from './find.ts';
import {
  checkIsPredicate,
  IS_PREDICATE_REQUIRED_MESSAGE,
  IS_PREDICATE_USAGE_HINT,
} from './predicates.ts';

test('an unsupported is predicate always carries the usage hint', () => {
  const refused = checkIsPredicate('nope');
  expect(refused).toEqual({
    ok: false,
    code: 'INVALID_ARGS',
    message: IS_PREDICATE_REQUIRED_MESSAGE,
    hint: IS_PREDICATE_USAGE_HINT,
  });
});

test('is predicates are admitted case-insensitively, matching what the daemon executes', () => {
  expect(checkIsPredicate('TEXT')).toEqual({ ok: true, predicate: 'text' });
  expect(checkIsPredicate('Visible')).toEqual({ ok: true, predicate: 'visible' });
});

test('checkIsArgs covers predicate, selector, expected text, and trailing values', () => {
  expect(checkIsArgs(['text', 'id="field"', 'hello', 'world'])).toEqual({
    ok: true,
    predicate: 'text',
    selectorExpression: 'id="field"',
    expectedText: 'hello world',
  });

  expect(checkIsArgs(['visible', 'id="field"'])).toMatchObject({
    ok: true,
    predicate: 'visible',
    expectedText: '',
  });

  expect(checkIsArgs(['text'])).toMatchObject({
    ok: false,
    message: SELECTOR_EXPRESSION_REQUIRED_MESSAGE,
  });
  expect(checkIsArgs(['text', 'id="field"'])).toMatchObject({
    ok: false,
    message: IS_TEXT_VALUE_REQUIRED_MESSAGE,
  });
  expect(checkIsArgs(['visible', 'id="field"', 'extra'])).toMatchObject({
    ok: false,
    message: 'is visible does not accept trailing values',
  });
});

test('get only formats text or attrs, and needs a ref or a selector', () => {
  expect(checkGetFormat('text')).toEqual({ ok: true, format: 'text' });
  expect(checkGetFormat('attrs')).toEqual({ ok: true, format: 'attrs' });
  expect(checkGetFormat('json')).toMatchObject({ message: 'get only supports text or attrs' });
  expect(checkGetFormat(undefined)).toMatchObject({ ok: false });

  expect(checkElementTargetArgs(['@e12'])).toEqual({ ok: true, ref: '@e12' });
  expect(checkElementTargetArgs(['@e12', 'Sign', 'in'])).toEqual({
    ok: true,
    ref: '@e12',
    label: 'Sign in',
  });
  expect(checkElementTargetArgs(['id="field"'])).toEqual({ ok: true, selector: 'id="field"' });
  expect(checkElementTargetArgs([])).toMatchObject({
    message: 'get requires @ref or selector expression',
  });
  expect(checkElementTargetArgs(['   '])).toMatchObject({ ok: false });
});

test('wait text and find value refusals are stated once', () => {
  expect(checkWaitText('Home')).toEqual({ ok: true, text: 'Home' });
  expect(checkWaitText('')).toMatchObject({ message: 'wait requires text' });
  expect(checkWaitText(undefined)).toMatchObject({ ok: false });

  expect(checkFindArgs([])).toMatchObject({ message: 'find requires a locator or text' });
  expect(checkFindArgs([''])).toMatchObject({ message: 'find requires a value' });
  expect(checkFindArgs(['id="field"'], { findFirst: true, findLast: true })).toMatchObject({
    message: 'find accepts only one of --first or --last',
  });
  expect(checkFindArgs(['id="field"'])).toMatchObject({ ok: true });
});
