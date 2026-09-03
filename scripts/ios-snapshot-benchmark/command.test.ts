import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  classifyFailure,
  firstTreeStatus,
  hasDeepLinkConfirmation,
  snapshotHasAnchor,
} from './command.ts';

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

test('admits only an exact semantic anchor from snapshot node fields', () => {
  const payload = {
    data: {
      results: [
        {
          data: {
            snapshot: {
              nodes: [{ label: 'Automation lab' }, { value: 'secondary value' }],
            },
          },
        },
      ],
    },
  };
  assert.equal(snapshotHasAnchor(payload, 'Automation lab'), true);
  assert.equal(snapshotHasAnchor(payload, 'secondary value'), true);
  assert.equal(snapshotHasAnchor(payload, 'Automation'), false);
  assert.equal(
    snapshotHasAnchor(
      { results: [{ data: { snapshot: { nodes: [{ label: 'Automation lab' }] } } }] },
      'Automation lab',
    ),
    true,
  );
});

test('recognizes the first-install deep-link confirmation as a setup prompt', () => {
  assert.equal(
    hasDeepLinkConfirmation({
      data: {
        results: [
          {
            data: {
              snapshot: {
                nodes: [{ role: 'alert', label: 'Open in “Agent Device Tester”?' }],
              },
            },
          },
        ],
      },
    }),
    true,
  );
  assert.equal(
    hasDeepLinkConfirmation({
      data: { results: [{ data: { snapshot: { nodes: [{ role: 'application' }] } } }] },
    }),
    false,
  );
});
