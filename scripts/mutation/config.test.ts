// The Stryker config and the module registry are two views of one scope. If
// they drift, the weekly sweep silently measures something other than the
// enumerated decision kernels — the exact failure this lane exists to catch.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mutateGlobs } from './modules.ts';
import { configHash } from './run.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function readConfig(): Record<string, unknown> {
  const text = fs.readFileSync(path.join(repoRoot, 'stryker.config.json'), 'utf8');
  return JSON.parse(text) as Record<string, unknown>;
}

test('stryker mutate globs mirror the kernel-module registry', () => {
  assert.deepEqual(
    readConfig().mutate,
    mutateGlobs(),
    'stryker.config.json `mutate` drifted from KERNEL_MODULES — update scripts/mutation/modules.ts and the config together.',
  );
});

test('stryker owns no pass/fail threshold — the ratchet does', () => {
  const thresholds = readConfig().thresholds as { break?: number | null } | undefined;
  assert.equal(
    thresholds?.break ?? null,
    null,
    "A Stryker `break` threshold would fail runs on an absolute score; gating is the ratchet's job (scripts/mutation/ratchet.ts).",
  );
});

test('the config content hash is stable and content-addressed', () => {
  assert.equal(configHash('a'), configHash('a'));
  assert.notEqual(configHash('a'), configHash('b'));
  assert.match(configHash('a'), /^sha256:[0-9a-f]{12}$/);
});
