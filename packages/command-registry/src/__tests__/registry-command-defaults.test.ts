import { test } from 'vitest';
import assert from 'node:assert/strict';
import { applyCommandDefaults } from '../registry.ts';

test('applyCommandDefaults fills the apps filter from the single registry table', () => {
  const flags: Record<string, unknown> = {};
  assert.equal(applyCommandDefaults('apps', flags), true);
  assert.equal(flags.appsFilter, 'user-installed');
});

test('applyCommandDefaults never overwrites a filter the caller supplied', () => {
  const flags: Record<string, unknown> = { appsFilter: 'all' };
  assert.equal(applyCommandDefaults('apps', flags), false);
  assert.equal(flags.appsFilter, 'all');
});

test('applyCommandDefaults is a no-op for commands and non-commands without a declared default', () => {
  for (const command of ['tap', 'snapshot', 'not-a-command', null]) {
    const flags: Record<string, unknown> = {};
    assert.equal(applyCommandDefaults(command, flags), false, `command ${command}`);
    assert.deepEqual(flags, {});
  }
});
