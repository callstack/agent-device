import assert from 'node:assert/strict';
import { test } from 'vitest';
import { detectUnknownSelectorKeyToken, isRoleHintWord, SELECTOR_KEY_NAMES } from './parse.ts';

test('detectUnknownSelectorKeyToken flags a role word used as a selector key', () => {
  assert.deepEqual(detectUnknownSelectorKeyToken('button="Push Article"'), {
    key: 'button',
    value: 'Push Article',
  });
});

test('detectUnknownSelectorKeyToken flags any non-recognized key, lowercased', () => {
  assert.deepEqual(detectUnknownSelectorKeyToken('Color="red"'), { key: 'color', value: 'red' });
  assert.deepEqual(detectUnknownSelectorKeyToken('unquoted=value'), {
    key: 'unquoted',
    value: 'value',
  });
});

test('detectUnknownSelectorKeyToken returns null for recognized selector keys', () => {
  assert.equal(detectUnknownSelectorKeyToken('id="submit"'), null);
  assert.equal(detectUnknownSelectorKeyToken('role=button'), null);
  assert.equal(detectUnknownSelectorKeyToken('visible=maybe'), null);
});

test('detectUnknownSelectorKeyToken returns null without an "=", an empty key, or an empty value', () => {
  assert.equal(detectUnknownSelectorKeyToken('10'), null);
  assert.equal(detectUnknownSelectorKeyToken('=value'), null);
  assert.equal(detectUnknownSelectorKeyToken('button='), null);
  assert.equal(detectUnknownSelectorKeyToken('button=""'), null);
  assert.equal(detectUnknownSelectorKeyToken('button="   "'), null);
});

test('isRoleHintWord recognizes common accessibility role words, case-insensitively', () => {
  assert.equal(isRoleHintWord('button'), true);
  assert.equal(isRoleHintWord('Button'), true);
  assert.equal(isRoleHintWord('textfield'), true);
  assert.equal(isRoleHintWord('color'), false);
  assert.equal(isRoleHintWord('unquoted'), false);
});

test('SELECTOR_KEY_NAMES lists the recognized selector keys and excludes role words', () => {
  assert.ok(SELECTOR_KEY_NAMES.includes('id'));
  assert.ok(SELECTOR_KEY_NAMES.includes('role'));
  assert.ok(SELECTOR_KEY_NAMES.includes('label'));
  assert.ok(SELECTOR_KEY_NAMES.includes('visible'));
  assert.equal((SELECTOR_KEY_NAMES as readonly string[]).includes('button'), false);
});
