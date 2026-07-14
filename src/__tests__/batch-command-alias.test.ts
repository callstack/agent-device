import { test } from 'vitest';
import assert from 'node:assert/strict';
import { readCliBatchStepsJson } from '../cli/batch-steps.ts';
import { readStructuredBatchCommandName, normalizeBatchCommandName } from '../batch-policy.ts';

// Batch steps carry the wire command in structured data that never passes through
// the CLI token parser, so the shared command-alias map is applied where each
// batch layer first reads the command name. This keeps shipped batch data that
// still says `rotate` resolving to canonical `orientation` instead of failing as
// "not available through command batch".

test('CLI batch parser resolves a deprecated rotate step to orientation', () => {
  const [step] = readCliBatchStepsJson(
    JSON.stringify([{ command: 'rotate', positionals: ['portrait'] }]),
  );
  assert.equal(step?.command, 'orientation');
});

test('CLI batch parser resolves a deprecated rotate alias case-insensitively', () => {
  const [step] = readCliBatchStepsJson(
    JSON.stringify([{ command: 'ROTATE', input: { orientation: 'landscape-left' } }]),
  );
  assert.equal(step?.command, 'orientation');
});

test('daemon batch policy accepts and normalizes a deprecated rotate step', () => {
  assert.equal(normalizeBatchCommandName('rotate'), 'orientation');
  assert.equal(readStructuredBatchCommandName('rotate', 1), 'orientation');
});

test('daemon batch policy leaves canonical and unknown names intact', () => {
  assert.equal(normalizeBatchCommandName('orientation'), 'orientation');
  assert.equal(normalizeBatchCommandName('press'), 'press');
  assert.throws(() => readStructuredBatchCommandName('not-a-command', 1), /not available/);
});

test('non-CLI batch normalization does not drop relaunch implied flags', () => {
  assert.equal(normalizeBatchCommandName('relaunch'), 'relaunch');
  assert.throws(() => readStructuredBatchCommandName('relaunch', 1), /not available/);
  assert.throws(
    () =>
      readCliBatchStepsJson(
        JSON.stringify([{ command: 'relaunch', positionals: ['com.example.app'] }]),
      ),
    /not available/,
  );
});
