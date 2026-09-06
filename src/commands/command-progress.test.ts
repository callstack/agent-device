import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createCommandProgressState, createStderrCommandProgressSink } from './command-progress.ts';

function captureStderr(run: () => void): string {
  let stderr = '';
  const originalWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as { write: unknown }).write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    run();
  } finally {
    process.stderr.write = originalWrite;
  }
  return stderr;
}

test('the stderr sink renders command progress and records that it did', () => {
  const state = createCommandProgressState();
  const sink = createStderrCommandProgressSink(state);
  assert.equal(state.renderedToStderr, false);

  const stderr = captureStderr(() => {
    sink({ type: 'command', status: 'progress', message: 'Building Apple runner...' });
  });

  assert.equal(stderr, 'Building Apple runner...\n');
  assert.equal(state.renderedToStderr, true);
});

test('the stderr sink leaves reporter-owned event types alone', () => {
  const state = createCommandProgressState();
  const sink = createStderrCommandProgressSink(state);

  const stderr = captureStderr(() => {
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
