import { test } from 'vitest';
import assert from 'node:assert/strict';
import { withCapturedStderr } from '../__tests__/test-utils/stream-capture.ts';
import { createCommandProgressState, createStderrCommandProgressSink } from './command-progress.ts';

test('the stderr sink renders command progress and records that it did', () => {
  const state = createCommandProgressState();
  const sink = createStderrCommandProgressSink(state);
  assert.equal(state.renderedToStderr, false);

  const stderr = withCapturedStderr(() => {
    sink({ type: 'command', status: 'progress', message: 'Building Apple runner...' });
  });

  assert.equal(stderr, 'Building Apple runner...\n');
  assert.equal(state.renderedToStderr, true);
});

test('the stderr sink leaves reporter-owned event types alone', () => {
  const state = createCommandProgressState();
  const sink = createStderrCommandProgressSink(state);

  const stderr = withCapturedStderr(() => {
    sink({
      type: 'replay-test',
      file: '/tmp/01-login.ad',
      status: 'pass',
      index: 1,
      total: 1,
    });
  });

  assert.equal(stderr, '');
  assert.equal(state.renderedToStderr, false);
});
