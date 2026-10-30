import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { graphEntries } from './entries.ts';

test('maps declared root and workspace exports to graph source files', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'depgraph-entries-'));
  fs.mkdirSync(path.join(repo, 'packages/example'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({
      exports: {
        '.': { default: './dist/src/index.js' },
        './io': { require: './dist/src/io.js' },
      },
    }),
  );
  fs.writeFileSync(
    path.join(repo, 'packages/example/package.json'),
    JSON.stringify({
      name: '@agent-device/example',
      exports: { '.': { require: './src/index.js' }, './alias': './src/index.ts' },
    }),
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', 'package.json', 'packages/example/package.json'], { cwd: repo });
  const entries = graphEntries(
    repo,
    new Set(['src/sdk/index.ts', 'src/sdk/io.ts', 'packages/example/src/index.ts']),
  );
  assert.deepEqual(entries['src (agent-device)'], [
    { id: 'sdk/index.ts', subpath: '.' },
    { id: 'sdk/io.ts', subpath: './io' },
  ]);
  assert.deepEqual(entries['packages/example'], [
    { id: 'packages/example/src/index.ts', subpath: '.' },
    { id: 'packages/example/src/index.ts', subpath: './alias' },
  ]);
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ exports: { './missing': { import: './dist/src/missing.js' } } }),
  );
  assert.throws(
    () => graphEntries(repo, new Set()),
    /Root export \.\/missing points to unknown build entry/,
  );
});
