import assert from 'node:assert/strict';
import { test } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { parseAndroidIntentExtras, qualifyAndroidActivity } from './android-intent-extras.ts';

test('am start extra flags map onto their Appium extra types', () => {
  assert.deepEqual(
    parseAndroidIntentExtras([
      '--es',
      'otaChannel',
      'qa-1234',
      '--ez',
      'fresh',
      'true',
      '--ei',
      'retries',
      '3',
    ]),
    [
      ['s', 'otaChannel', 'qa-1234'],
      ['z', 'fresh', 'true'],
      ['i', 'retries', '3'],
    ],
  );
});

// `--esn` sets a null string, so it is the one extra whose key is not followed by a value.
test('the null-string extra consumes a key and no value', () => {
  assert.deepEqual(parseAndroidIntentExtras(['--esn', 'cleared', '--es', 'k', 'v']), [
    ['sn', 'cleared'],
    ['s', 'k', 'v'],
  ]);
});

test('no launch arguments produce no extras', () => {
  assert.deepEqual(parseAndroidIntentExtras([]), []);
});

// Appium validates the type field and nothing else, so an unknown flag would be dropped in transit
// rather than rejected. The closest negative to the mapping above.
test('an unknown flag is refused rather than dropped', () => {
  assert.throws(
    () => parseAndroidIntentExtras(['--flag', 'value']),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'INVALID_ARGS');
      assert.match(error.message, /Unsupported Android launch argument: --flag/);
      assert.match(String(error.details?.hint), /--e<type> <key> <value>/);
      return true;
    },
  );
});

test('a truncated extra is refused rather than sent with a missing operand', () => {
  for (const [args, missing] of [
    [['--es'], /missing a key/],
    [['--es', 'key'], /missing a value/],
    [['--esn'], /missing a key/],
  ] as const) {
    assert.throws(
      () => parseAndroidIntentExtras(args),
      (error: unknown) => {
        assert.ok(error instanceof AppError);
        assert.equal(error.code, 'INVALID_ARGS');
        assert.match(error.message, missing);
        return true;
      },
    );
  }
});

test('a relative activity is qualified with the package, a full component is left alone', () => {
  assert.equal(qualifyAndroidActivity('com.example.app', '.Main'), 'com.example.app/.Main');
  assert.equal(qualifyAndroidActivity('com.example.app', 'com.other/.Main'), 'com.other/.Main');
});
