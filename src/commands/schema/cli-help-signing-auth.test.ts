import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { buildCommandUsageText } from './cli-help.ts';

// The ASC API key reasons are named in hand-written prose across the help and three doc pages,
// while the reason table lives in the apple-runner package and generates error-reasons.md. These
// tests pin the prose to the generated table, so a rename on the code side that skips the prose
// fails here instead of shipping a dead branch target.

const HELP = buildCommandUsageText('physical-device') ?? '';
const DOCS_DIR = path.join(import.meta.dirname, '../../../website/docs/docs');

const SIGNING_AUTH_REASONS = ['signing_auth_key_incomplete', 'signing_auth_key_invalid_path'];

test('both signing auth key reasons are in the help and in the generated reason table', () => {
  const reasonsDoc = fs.readFileSync(path.join(DOCS_DIR, 'error-reasons.md'), 'utf8');
  for (const reason of SIGNING_AUTH_REASONS) {
    assert.ok(HELP.includes(reason), `the help no longer names ${reason}`);
    assert.ok(
      reasonsDoc.split('\n').some((line) => line.startsWith(`| \`${reason}\` `)),
      `error-reasons.md has no runner reason row for ${reason}`,
    );
  }
});

for (const doc of ['installation.md', 'configuration.md', 'error-reasons.md']) {
  test(`${doc} documents signing_auth_key_invalid_path`, () => {
    const text = fs.readFileSync(path.join(DOCS_DIR, doc), 'utf8');
    assert.ok(
      text.includes('signing_auth_key_invalid_path'),
      `${doc} omits signing_auth_key_invalid_path`,
    );
  });
}
