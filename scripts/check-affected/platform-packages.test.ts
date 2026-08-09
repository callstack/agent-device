import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectChecks } from './model.ts';

test('platform package source selects runtime contracts, provider scenarios, and coverage', () => {
  for (const file of [
    'packages/platform-apple/src/index.ts',
    'packages/platform-harmonyos/src/inventory.test.ts',
    'packages/platform-future/src/runtime.ts',
  ]) {
    const result = selectChecks({ changedFiles: [file] });
    assert.equal(result.failOpen, false, file);
    for (const id of ['unit', 'provider-integration', 'coverage'] as const) {
      assert.ok(result.checks.includes(id), `expected ${id} for ${file}`);
    }
    assert.ok(
      result.reasons.some((reason) => reason.rule === 'platform-package-contract'),
      `expected explicit platform contract ownership for ${file}`,
    );
  }
});
