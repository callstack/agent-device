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

test('wait text refusals are stated once', () => {
  expect(checkWaitText('Home')).toEqual({ ok: true, text: 'Home' });
  expect(checkWaitText('')).toMatchObject({ message: 'wait requires text' });
  expect(checkWaitText(undefined)).toMatchObject({ ok: false });
});
