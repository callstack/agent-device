// Characterization of the shipped reporter value contract (#1478 P3).
//
// A custom reporter never sees a `RequestProgressEvent`; it sees the value this module
// projects. P3 moves that projection behind a package façade, so the projection's field
// set, key presence, and verbatim pass-through are pinned here as shipped behavior — not
// as a proposal. Reporters in the wild read `test.session` and probe optional keys with
// `in`, so a key that exists today with an `undefined` value is part of the contract.
import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import { toReplayTestReporterProgressEvent } from '../progress.ts';

const SESSION = 'default:test:req-7:1-checkout:attempt-2';

const TEST_CASE_KEYS = [
  'file',
  'title',
  'index',
  'total',
  'attempt',
  'maxAttempts',
  'session',
  'artifactsDir',
  'shardIndex',
  'shardCount',
  'deviceId',
  'deviceName',
];

test('command progress never reaches a reporter hook', () => {
  assert.equal(
    toReplayTestReporterProgressEvent({
      type: 'command',
      status: 'progress',
      message: 'installing app',
    }),
    undefined,
  );
});

test('suite progress becomes the onSuiteStart value with exactly the shipped fields', () => {
  const event = toReplayTestReporterProgressEvent({
    type: 'replay-test-suite',
    status: 'start',
    total: 5,
    runnable: 4,
    skipped: 1,
    artifactsDir: '/artifacts/req-7',
    shardMode: 'split',
    shardCount: 2,
  });

  assert.deepEqual(event, {
    type: 'suite-start',
    suite: {
      total: 5,
      runnable: 4,
      skipped: 1,
      artifactsDir: '/artifacts/req-7',
      shardMode: 'split',
      shardCount: 2,
    },
  });
});

test('an unsharded suite start still carries the shard keys as undefined', () => {
  const event = toReplayTestReporterProgressEvent({
    type: 'replay-test-suite',
    status: 'start',
    total: 1,
    runnable: 1,
    skipped: 0,
    artifactsDir: '/artifacts/req-7',
  });

  assert.equal(event?.type, 'suite-start');
  assert.deepEqual(Object.keys(event.suite), [
    'total',
    'runnable',
    'skipped',
    'artifactsDir',
    'shardMode',
    'shardCount',
  ]);
  assert.equal(event.suite.shardMode, undefined);
  assert.equal(event.suite.shardCount, undefined);
});

test('start progress becomes onTestStart and passes session through verbatim', () => {
  const event = toReplayTestReporterProgressEvent({
    type: 'replay-test',
    file: '/suite/01-checkout.ad',
    title: 'Checkout',
    status: 'start',
    index: 1,
    total: 2,
    maxAttempts: 3,
    session: SESSION,
    artifactsDir: '/artifacts/req-7/01-checkout.ad',
    shardIndex: 0,
    shardCount: 2,
    deviceId: 'emulator-5554',
    deviceName: 'Pixel 8',
  });

  assert.deepEqual(event, {
    type: 'test-start',
    test: {
      file: '/suite/01-checkout.ad',
      title: 'Checkout',
      index: 1,
      total: 2,
      attempt: undefined,
      maxAttempts: 3,
      session: SESSION,
      artifactsDir: '/artifacts/req-7/01-checkout.ad',
      shardIndex: 0,
      shardCount: 2,
      deviceId: 'emulator-5554',
      deviceName: 'Pixel 8',
    },
  });
});

test('a minimal test event still carries every case key, so `in` checks keep working', () => {
  const event = toReplayTestReporterProgressEvent({
    type: 'replay-test',
    file: '/suite/01-checkout.ad',
    status: 'start',
    index: 1,
    total: 1,
  });

  assert.equal(event?.type, 'test-start');
  assert.deepEqual(Object.keys(event.test), TEST_CASE_KEYS);
  assert.equal('session' in event.test, true);
  assert.equal(event.test.session, undefined);
});

test('step progress becomes onTestStep with the step fields appended after the case fields', () => {
  const event = toReplayTestReporterProgressEvent({
    type: 'replay-test',
    file: '/suite/01-checkout.ad',
    status: 'progress',
    index: 1,
    total: 1,
    attempt: 2,
    maxAttempts: 3,
    session: SESSION,
    stepIndex: 3,
    stepTotal: 9,
    stepCommand: 'tap',
    stepValue: 'Submit',
  });

  assert.equal(event?.type, 'test-step');
  assert.deepEqual(Object.keys(event.test), [
    ...TEST_CASE_KEYS,
    'stepIndex',
    'stepTotal',
    'stepCommand',
    'stepValue',
  ]);
  assert.equal(event.test.session, SESSION);
  assert.equal(event.test.attempt, 2);
  assert.equal(event.test.stepIndex, 3);
  assert.equal(event.test.stepCommand, 'tap');
  assert.equal(event.test.stepValue, 'Submit');
});

test.each(['pass', 'fail', 'skip'] as const)(
  '%s progress becomes onTestResult with the status carried through',
  (status) => {
    const event = toReplayTestReporterProgressEvent({
      type: 'replay-test',
      file: '/suite/01-checkout.ad',
      status,
      index: 1,
      total: 1,
      attempt: 2,
      maxAttempts: 3,
      durationMs: 1234,
      retrying: status === 'fail',
      message: 'selector not found',
      hint: 'run replay --from',
      session: SESSION,
    });

    assert.equal(event?.type, 'test-result');
    assert.deepEqual(Object.keys(event.test), [
      ...TEST_CASE_KEYS,
      'status',
      'durationMs',
      'retrying',
      'message',
      'hint',
    ]);
    assert.equal(event.test.status, status);
    assert.equal(event.test.durationMs, 1234);
    assert.equal(event.test.retrying, status === 'fail');
    assert.equal(event.test.message, 'selector not found');
    assert.equal(event.test.hint, 'run replay --from');
    assert.equal(event.test.session, SESSION);
  },
);

test('a skipped entry reaches onTestResult without a session', () => {
  const skipEvent: RequestProgressEvent = {
    type: 'replay-test',
    file: '/suite/02-ios-only.ad',
    status: 'skip',
    index: 2,
    total: 2,
    message: 'missing platform metadata for --platform android',
  };

  const event = toReplayTestReporterProgressEvent(skipEvent);

  assert.equal(event?.type, 'test-result');
  assert.equal(event.test.status, 'skip');
  assert.equal(event.test.session, undefined);
  assert.equal(event.test.durationMs, undefined);
});
