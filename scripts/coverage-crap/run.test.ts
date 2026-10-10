import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { run } from './run.ts';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'coverage-crap-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('fails with the command to run when no coverage map exists', () => {
  const chunks: string[] = [];
  const originalErr = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    assert.equal(run(['--base', 'main'], root), 1);
  } finally {
    process.stderr.write = originalErr;
  }
  assert.match(chunks.join(''), /no Istanbul coverage map .*Run `pnpm test:coverage` first/);
});
