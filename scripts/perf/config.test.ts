import assert from 'node:assert/strict';
import { test } from 'vitest';
import { parseConfig } from './config.ts';

test('a run measures at least three rounds, so every step can get a timing verdict', () => {
  assert.equal(parseConfig(['--udid', 'sim', '--rounds', '3']).rounds, 3);
  assert.throws(() => parseConfig(['--udid', 'sim', '--rounds', '2']), /--rounds must be .* >= 3/);
  assert.throws(
    () => parseConfig(['--platform', 'android', '--serial', 'emulator-5554', '--n', '1']),
    /--n must be .* >= 3/,
  );
});

test('each platform requires its device selector', () => {
  assert.throws(() => parseConfig(['--platform', 'ios']), /--udid is required/);
  assert.throws(() => parseConfig(['--platform', 'android']), /--serial is required/);
  assert.equal(
    parseConfig(['--platform', 'android', '--serial', 'emulator-5554']).serial,
    'emulator-5554',
  );
});
