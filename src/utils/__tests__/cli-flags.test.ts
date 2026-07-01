import { test } from 'vitest';
import assert from 'node:assert/strict';
import { getFlagDefinition } from '../../cli/parser/cli-flags.ts';
import { PLATFORM_SELECTORS } from '../../kernel/device.ts';

test('--platform enumValues are derived from the canonical PLATFORM_SELECTORS tuple', () => {
  const platformFlag = getFlagDefinition('--platform');
  assert.ok(platformFlag, 'expected a --platform flag definition');
  assert.deepEqual(platformFlag.enumValues, [...PLATFORM_SELECTORS]);
  // Guard the exact membership that today's CLI accepts so the derivation cannot drift.
  assert.deepEqual(platformFlag.enumValues, ['apple', 'android', 'linux', 'web', 'ios', 'macos']);
});

test('--platform usageLabel lists the same selectors as enumValues', () => {
  const platformFlag = getFlagDefinition('--platform');
  assert.ok(platformFlag);
  assert.equal(platformFlag.usageLabel, `--platform ${PLATFORM_SELECTORS.join('|')}`);
});
