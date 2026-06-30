import assert from 'node:assert/strict';
import { test } from 'vitest';
import { trimLeadingSlash, trimTrailingSlash } from '../webdriver-utils.ts';

test('slash trimming utilities handle slash-heavy strings without regular expressions', () => {
  const slashRun = '/'.repeat(10_000);

  assert.equal(trimLeadingSlash(`${slashRun}wd/hub`), 'wd/hub');
  assert.equal(
    trimTrailingSlash(`https://example.test/wd/hub${slashRun}`),
    'https://example.test/wd/hub',
  );
  assert.equal(trimLeadingSlash('wd/hub'), 'wd/hub');
  assert.equal(trimTrailingSlash('https://example.test/wd/hub'), 'https://example.test/wd/hub');
  assert.equal(trimLeadingSlash(slashRun), '');
  assert.equal(trimTrailingSlash(slashRun), '');
});
