import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizePath } from './repo-path.ts';

test('normalizePath strips root, b/ and ./ prefixes and posixifies', () => {
  assert.equal(normalizePath('/repo/src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(normalizePath('b/src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath('./src/a.ts'), 'src/a.ts');
  assert.equal(normalizePath(String.raw`src\a.ts`), 'src/a.ts');
});
