import assert from 'node:assert/strict';
import { test } from 'vitest';
import { classifyFailure, firstTreeStatus } from './command.ts';

test('classifies typed reasons without using error message text', () => {
  assert.equal(
    classifyFailure({ error: { code: 'COMMAND_FAILED', message: 'timeout-looking text' } })
      .category,
    'other',
  );
  assert.equal(
    classifyFailure({
      error: {
        code: 'COMMAND_FAILED',
        message: 'unrelated text',
        details: { reason: 'stale_generation' },
      },
    }).category,
    'stale-generation',
  );
  assert.equal(
    classifyFailure({
      error: { code: 'COMMAND_FAILED', details: { reason: 'first_tree_unreadable' } },
    }).category,
    'app-mount',
  );
});

test('keeps empty, readable, unreadable, and unobserved first trees distinct', () => {
  assert.equal(firstTreeStatus({ data: { nodes: [] } }), 'empty');
  assert.equal(firstTreeStatus({ data: { nodes: [{ ref: '@e1' }] } }), 'readable');
  assert.equal(firstTreeStatus({ error: { details: { reason: 'first_tree_empty' } } }), 'empty');
  assert.equal(
    firstTreeStatus({ error: { details: { reason: 'first_tree_unreadable' } } }),
    'unreadable',
  );
  assert.equal(
    firstTreeStatus({ error: { details: { reason: 'bridge_unavailable' } } }),
    'not-observed',
  );
});
