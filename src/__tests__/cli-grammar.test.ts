import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readInputFromCli } from '../commands/cli-grammar.ts';
import type { CliFlags } from '../commands/cli-grammar/flag-types.ts';

const BASE_FLAGS: CliFlags = {
  json: false,
  help: false,
  version: false,
};

test('wait grammar preserves CLI bare text forms', () => {
  const options = readInputFromCli('wait', ['Continue', '1500'], BASE_FLAGS);
  assert.equal(options.text, 'Continue');
  assert.equal(options.timeoutMs, 1500);
});

test('snapshot grammar keeps interactive snapshot options focused', () => {
  const options = readInputFromCli('snapshot', [], {
    ...BASE_FLAGS,
    snapshotInteractiveOnly: true,
    snapshotDepth: 3,
  });

  assert.equal(options.interactiveOnly, true);
  assert.equal(options.depth, 3);
});

test('interaction and fill grammar share ref, selector, and point parsing', () => {
  assert.deepEqual(readInputFromCli('press', ['@e3', 'Email'], BASE_FLAGS).target, {
    kind: 'ref',
    ref: '@e3',
    label: 'Email',
  });
  const selectorFill = readInputFromCli('fill', ['id=email', 'qa@example.com'], BASE_FLAGS);
  assert.deepEqual(selectorFill.target, { kind: 'selector', selector: 'id=email' });
  assert.equal(selectorFill.text, 'qa@example.com');

  const refFill = readInputFromCli('fill', ['@e4', 'Email', 'qa@example.com'], BASE_FLAGS);
  assert.deepEqual(refFill.target, { kind: 'ref', ref: '@e4', label: 'Email' });
  assert.equal(refFill.text, 'qa@example.com');

  const pointFill = readInputFromCli('fill', ['10', '20', 'hello'], BASE_FLAGS);
  assert.deepEqual(pointFill.target, { kind: 'point', x: 10, y: 20 });
  assert.equal(pointFill.text, 'hello');

  assert.deepEqual(readInputFromCli('longpress', ['@e4', '800'], BASE_FLAGS), {
    target: { kind: 'ref', ref: '@e4' },
    durationMs: 800,
  });
  assert.deepEqual(readInputFromCli('longpress', ['10', '20', '800'], BASE_FLAGS), {
    target: { kind: 'point', x: 10, y: 20 },
    durationMs: 800,
  });
});

test('interaction selectors reject unquoted trailing text instead of dropping it', () => {
  assert.throws(
    () => readInputFromCli('press', ['text=Gesture', 'lab'], BASE_FLAGS),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /unexpected extra arguments: "lab"/);
      assert.match(err.message, /text="Gesture lab"/);
      return true;
    },
  );
  assert.throws(
    () => readInputFromCli('click', ['role=button', 'text=Sign', 'in'], BASE_FLAGS),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /unexpected extra arguments: "in"/);
      assert.match(err.message, /role=button text="Sign in"/);
      return true;
    },
  );
  assert.throws(
    () => readInputFromCli('longpress', ['text=Gesture', 'lab'], BASE_FLAGS),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /unexpected extra arguments: "lab"/);
      return true;
    },
  );

  // Quoted selector values and fill's trailing text payload keep working.
  assert.deepEqual(readInputFromCli('press', ['text="Gesture lab"'], BASE_FLAGS).target, {
    kind: 'selector',
    selector: 'text="Gesture lab"',
  });
  const fillAfterSelector = readInputFromCli('fill', ['id=email', 'qa@example.com'], BASE_FLAGS);
  assert.deepEqual(fillAfterSelector.target, { kind: 'selector', selector: 'id=email' });
  assert.equal(fillAfterSelector.text, 'qa@example.com');
});

test('bare snapshot refs without @ prefix throw helpful error', () => {
  assert.throws(
    () => readInputFromCli('click', ['e3'], BASE_FLAGS),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /Did you mean "@e3"\?/);
      return true;
    },
  );
  assert.throws(
    () => readInputFromCli('press', ['e123'], BASE_FLAGS),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /Did you mean "@e123"\?/);
      return true;
    },
  );
  assert.throws(
    () => readInputFromCli('fill', ['e5', 'text'], BASE_FLAGS),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(err.message, /Did you mean "@e5"\?/);
      return true;
    },
  );
});

test('find and is grammar decodes command action positionals', () => {
  const findOptions = readInputFromCli('find', ['label', 'Continue', 'wait', '3000'], {
    ...BASE_FLAGS,
    platform: 'ios',
    findFirst: true,
  });
  assert.equal(findOptions.platform, 'ios');
  assert.equal(findOptions.locator, 'label');
  assert.equal(findOptions.query, 'Continue');
  assert.equal(findOptions.action, 'wait');
  assert.equal(findOptions.timeoutMs, 3000);
  assert.equal(findOptions.first, true);

  const isOptions = readInputFromCli('is', ['text', 'id=title', 'Welcome'], BASE_FLAGS);
  assert.equal(isOptions.predicate, 'text');
  assert.equal(isOptions.selector, 'id=title');
  assert.equal(isOptions.value, 'Welcome');
});

test('readers omit noRecord entirely when the flag is absent', () => {
  const options = readInputFromCli('press', ['@e5'], BASE_FLAGS);
  assert.equal(Object.hasOwn(options, 'noRecord'), false);
});

test('is grammar accepts the selector-first form with a trailing predicate', () => {
  // `visible` is both a selector boolean key and a predicate; the trailing bare token
  // must be reserved as the predicate instead of being swallowed by the selector.
  const trailingVisible = readInputFromCli('is', ['text=Zzznope', 'visible'], BASE_FLAGS);
  assert.equal(trailingVisible.predicate, 'visible');
  assert.equal(trailingVisible.selector, 'text=Zzznope');

  const trailingText = readInputFromCli('is', ['id=title', 'text', 'Welcome'], BASE_FLAGS);
  assert.equal(trailingText.predicate, 'text');
  assert.equal(trailingText.selector, 'id=title');
  assert.equal(trailingText.value, 'Welcome');

  // Predicate-first stays canonical: a bare trailing predicate name after a
  // predicate-first expression is a selector boolean term, not a second predicate.
  const predicateFirst = readInputFromCli('is', ['visible', 'text=Foo', 'hidden'], BASE_FLAGS);
  assert.equal(predicateFirst.predicate, 'visible');
  assert.equal(predicateFirst.selector, 'text=Foo hidden');
});

test('is grammar explains the predicate/selector-key collision on invalid predicates', () => {
  assert.throws(
    () => readInputFromCli('is', ['text=Zzznope', 'nope'], BASE_FLAGS),
    (err: any) => {
      assert.equal(err.code, 'INVALID_ARGS');
      assert.match(
        err.message,
        /is requires predicate: visible\|hidden\|exists\|editable\|selected\|focused\|text/,
      );
      assert.match(err.details?.hint ?? '', /is <selector> <predicate>/);
      assert.match(err.details?.hint ?? '', /visible=true/);
      return true;
    },
  );
});

test('settings grammar owns positional parsing for CLI commands', () => {
  const location = readInputFromCli('settings', ['location', 'set', '37.3349', '-122.009'], {
    ...BASE_FLAGS,
    platform: 'ios',
  });
  assert.equal(location.platform, 'ios');
  assert.equal(location.setting, 'location');
  assert.equal(location.state, 'set');
  assert.equal(location.latitude, 37.3349);
  assert.equal(location.longitude, -122.009);

  const clearAppState = readInputFromCli('settings', ['clear-app-state', 'com.example.app'], {
    ...BASE_FLAGS,
    platform: 'android',
  });
  assert.equal(clearAppState.platform, 'android');
  assert.equal(clearAppState.setting, 'clear-app-state');
  assert.equal(clearAppState.state, 'clear');
  assert.equal(clearAppState.app, 'com.example.app');
});
