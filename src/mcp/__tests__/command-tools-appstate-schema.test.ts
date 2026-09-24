import assert from 'node:assert/strict';
import { test } from 'vitest';
import { COMMAND_OUTPUT_SCHEMAS } from '../command-output-schemas.ts';
import { validateAgainstSchema } from './output-schema-validator.ts';

// `appstate` on iOS answers from the session record, and from a live runner when one can read the
// session app's XCUIApplication state; the schema must accept both answers and reject a state word
// the contract does not declare.
const IOS_SESSION_ANSWER: Readonly<Record<string, unknown>> = {
  platform: 'ios',
  appName: 'Benchmark',
  appBundleId: 'dev.e2e.benchmark',
  source: 'session',
  surface: 'app',
  device_udid: '279A81EC-B61A-4BE2-9F71-6A40FB8D2F9A',
  ios_simulator_device_set: null,
};

test('MCP appstate schema accepts the runner-read iOS answer beside the session-only one', () => {
  assert.deepEqual(validateAgainstSchema(IOS_SESSION_ANSWER, COMMAND_OUTPUT_SCHEMAS.appstate), []);
  assert.deepEqual(
    validateAgainstSchema(
      { ...IOS_SESSION_ANSWER, source: 'runner', state: 'runningBackgroundSuspended' },
      COMMAND_OUTPUT_SCHEMAS.appstate,
    ),
    [],
  );
  assert.notDeepEqual(
    validateAgainstSchema(
      { ...IOS_SESSION_ANSWER, source: 'runner', state: 'sleeping' },
      COMMAND_OUTPUT_SCHEMAS.appstate,
    ),
    [],
  );
  assert.deepEqual(
    validateAgainstSchema(
      { platform: 'android', package: 'com.example.app', activity: '.MainActivity' },
      COMMAND_OUTPUT_SCHEMAS.appstate,
    ),
    [],
  );
});
