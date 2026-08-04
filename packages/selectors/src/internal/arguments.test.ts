// Where a selector expression ends and the command's remaining positionals
// begin, for both argument grammars.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { splitIsSelectorArgs } from './arguments.ts';
import { splitSelectorFromArgs } from './parse.ts';

test('splitSelectorFromArgs extracts selector prefix and trailing value', () => {
  const split = splitSelectorFromArgs(['id=login_email', 'editable=true', 'qa@example.com']);
  assert.ok(split);
  assert.equal(split.selectorExpression, 'id=login_email editable=true');
  assert.deepEqual(split.rest, ['qa@example.com']);
});

test('splitSelectorFromArgs prefers trailing token for value when requested', () => {
  const split = splitSelectorFromArgs(['label="Filter"', 'visible=true'], {
    preferTrailingValue: true,
  });
  assert.ok(split);
  assert.equal(split.selectorExpression, 'label="Filter"');
  assert.deepEqual(split.rest, ['visible=true']);
});

test('splitSelectorFromArgs keeps full selector when trailing value preference is disabled', () => {
  const split = splitSelectorFromArgs(['label="Filter"', 'visible=true']);
  assert.ok(split);
  assert.equal(split.selectorExpression, 'label="Filter" visible=true');
  assert.deepEqual(split.rest, []);
});

test('splitIsSelectorArgs accepts both predicate-first and selector-first forms', () => {
  const predicateFirst = splitIsSelectorArgs(['visible', 'text=Zzznope']);
  assert.equal(predicateFirst.predicate, 'visible');
  assert.equal(predicateFirst.split?.selectorExpression, 'text=Zzznope');
  assert.deepEqual(predicateFirst.split?.rest, []);

  // The trailing bare predicate must not be swallowed into the selector as a
  // boolean term (`visible` is both a selector key and a predicate name).
  const selectorFirst = splitIsSelectorArgs(['text=Zzznope', 'visible']);
  assert.equal(selectorFirst.predicate, 'visible');
  assert.equal(selectorFirst.split?.selectorExpression, 'text=Zzznope');
  assert.deepEqual(selectorFirst.split?.rest, []);

  const selectorFirstText = splitIsSelectorArgs(['id=title', 'text', 'Welcome']);
  assert.equal(selectorFirstText.predicate, 'text');
  assert.equal(selectorFirstText.split?.selectorExpression, 'id=title');
  assert.deepEqual(selectorFirstText.split?.rest, ['Welcome']);
});
