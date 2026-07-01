import assert from 'node:assert/strict';
import { test } from 'vitest';

import { isTrustedInstallSourceUrl, validateDownloadSourceUrl } from '../sdk/install-source.ts';

test('public install-source entrypoint re-exports pure helpers', () => {
  assert.equal(
    isTrustedInstallSourceUrl('https://api.github.com/repos/acme/app/actions/artifacts/1/zip'),
    true,
  );
  assert.equal(typeof validateDownloadSourceUrl, 'function');
});
