import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  listUntrackedProductionTypeScriptFiles,
  readTrackedPlatformPackageDeclarations,
} from './platform-package-repository.ts';

test('committed-state discovery rejects untracked production and ignores untracked manifests', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-package-policy-'));
  fs.mkdirSync(path.join(repo, 'packages/platform-apple/src'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'packages/platform-apple/package.json'),
    JSON.stringify({
      name: '@agent-device/platform-apple',
      private: true,
      exports: { '.': './src/index.ts' },
    }),
  );
  fs.writeFileSync(path.join(repo, 'packages/platform-apple/src/index.ts'), 'export {};\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.test', 'commit', '-qm', 'base'],
    { cwd: repo },
  );

  fs.writeFileSync(
    path.join(repo, 'packages/platform-apple/src/mechanics.ts'),
    'export const mechanics = true;\n',
  );
  fs.writeFileSync(
    path.join(repo, 'packages/platform-apple/src/mechanics.test.ts'),
    'export {};\n',
  );
  fs.mkdirSync(path.join(repo, 'packages/platform-android'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'packages/platform-android/package.json'),
    JSON.stringify({ name: '@agent-device/platform-android', private: true }),
  );

  assert.deepEqual(listUntrackedProductionTypeScriptFiles(repo), [
    'packages/platform-apple/src/mechanics.ts',
  ]);
  assert.deepEqual(
    readTrackedPlatformPackageDeclarations(repo).map(({ family }) => family),
    ['apple'],
  );
});
