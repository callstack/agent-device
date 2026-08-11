import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');

test('the npm package excludes repository skills', async () => {
  const manifest = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')) as {
    files?: string[];
  };
  const publishedSkills = (manifest.files ?? []).filter(
    (entry) => entry === 'skills' || entry.startsWith('skills/'),
  );

  assert.deepEqual(
    publishedSkills,
    [],
    'skills are installed from the repository and must not ship in the npm CLI package',
  );
});
