import { test } from 'vitest';
import assert from 'node:assert/strict';
import { isInteractive } from '../env-map.ts';

test('isInteractive requires a tty and detects CI environment markers', () => {
  assert.equal(isInteractive({ isTTY: true }, {}), true);
  assert.equal(isInteractive({ isTTY: false }, {}), false);
  assert.equal(isInteractive({}, {}), false);
  assert.equal(isInteractive({ isTTY: true }, { CI: '' }), true);
  assert.equal(isInteractive({ isTTY: true }, { CI: '   ' }), false);
  assert.equal(isInteractive({ isTTY: true }, { CI: 'false' }), true);
  assert.equal(isInteractive({ isTTY: true }, { CI: '0' }), true);
  assert.equal(isInteractive({ isTTY: true }, { CI: 'false', GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isInteractive({ isTTY: true }, { CI: '0', GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isInteractive({ isTTY: true }, { CI: 'true' }), false);
  assert.equal(isInteractive({ isTTY: true }, { CI: '1' }), false);
  assert.equal(isInteractive({ isTTY: true }, { BUILD_NUMBER: '123' }), false);
  assert.equal(isInteractive({ isTTY: true }, { CONTINUOUS_INTEGRATION: 'true' }), false);
  assert.equal(isInteractive({ isTTY: true }, { GITHUB_ACTIONS: 'true' }), false);
  assert.equal(isInteractive({ isTTY: true }, { BUILDKITE: 'true' }), false);
  assert.equal(
    isInteractive({ isTTY: true }, { GITHUB_ACTIONS: 'false', BUILDKITE: 'false' }),
    true,
  );
});
