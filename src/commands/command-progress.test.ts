import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { withCapturedStderr } from '@agent-device/test-kit';
import { createCommandProgressState, createStderrCommandProgressSink } from './command-progress.ts';

test('the stderr sink renders command progress and records that it did', () => {
  const state = createCommandProgressState();
  const sink = createStderrCommandProgressSink(state);
  assert.equal(state.renderedToStderr, false);

  const stderr = withCapturedStderr(() => {
    sink({
      type: 'command',
      status: 'progress',
      message: 'Building Apple runner (one-time per agent-device version)...',
    });
  });

  assert.equal(stderr, 'Building Apple runner (one-time per agent-device version)...\n');
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

test('the stderr sink escapes control characters in a progress message', () => {
  const sink = createStderrCommandProgressSink(createCommandProgressState());

  const stderr = withCapturedStderr(() => {
    sink({ type: 'command', status: 'progress', message: 'Installing /tmp/a\u001b[8mb\u009b.app' });
  });

  assert.equal(stderr, String.raw`Installing /tmp/a\u001b[8mb\u009b.app` + '\n');
});

test('the stderr sink colors a marked line after escaping it', async () => {
  const sink = createStderrCommandProgressSink(createCommandProgressState(), { FORCE_COLOR: '1' });
  const write = () =>
    withCapturedStderr(() => {
      sink({
        type: 'command',
        status: 'progress',
        message: '✓ device: ok \u001b[8m',
        marker: 'pass',
      });
    });

  // The sink loads marker color asynchronously, so wait until a line comes out colored.
  const stderr = await vi.waitFor(() => {
    const out = write();
    assert.ok(out.startsWith('\u001b['), out);
    return out;
  });

  assert.ok(stderr.includes(String.raw`device: ok \u001b[8m`), stderr);
  assert.equal(stderr.includes('ok \u001b[8m'), false);
});
