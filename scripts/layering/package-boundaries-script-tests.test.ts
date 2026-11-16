import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { checkPackageBoundaries } from './package-boundaries.ts';

test('R11 discovers real workspace imports in script tests without parsing fixture strings', () => {
  const repo = mkdtempForTestSync('package-boundaries-script-tests-');
  const helper = path.join(repo, 'packages/helper');
  fs.mkdirSync(path.join(helper, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts/nested'), { recursive: true });
  fs.writeFileSync(
    path.join(helper, 'package.json'),
    JSON.stringify({ name: '@agent-device/helper', private: true, exports: './src/index.ts' }),
  );
  fs.writeFileSync(path.join(helper, 'src/index.ts'), 'export const value = 1;');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ private: true }));
  fs.writeFileSync(
    path.join(repo, 'scripts/nested/probe.test.ts'),
    `import { value } from '@agent-device/helper';
     const fixture = "import { missing } from '@agent-device/absent';";`,
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  const violations = checkPackageBoundaries(repo);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, 'R11 package-boundaries');
  assert.equal(violations[0]!.file, 'scripts/nested/probe.test.ts');
  assert.equal(violations[0]!.line, 1);
  assert.match(violations[0]!.message, /helper.*not a.*workspace:\*/);

  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ private: true, devDependencies: { '@agent-device/helper': 'workspace:*' } }),
  );
  assert.deepEqual(checkPackageBoundaries(repo), []);
});

test('R11 scans script test relative tunnels, unknown packages and unexported subpaths', () => {
  const repo = mkdtempForTestSync('package-boundaries-script-routes-');
  fs.mkdirSync(path.join(repo, 'packages/helper/src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'scripts/nested'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, 'packages/helper/package.json'),
    JSON.stringify({ name: '@agent-device/helper', exports: './src/index.ts' }),
  );
  fs.writeFileSync(path.join(repo, 'packages/helper/src/index.ts'), 'export const value = 1;');
  fs.writeFileSync(
    path.join(repo, 'package.json'),
    JSON.stringify({ devDependencies: { '@agent-device/helper': 'workspace:*' } }),
  );
  fs.writeFileSync(
    path.join(repo, 'scripts/nested/probe.test.ts'),
    `import './ordinary.ts';
import '../../packages/helper/src/index.ts';
import '@agent-device/absent';
import '@agent-device/helper/private';
import '@agent-device/helper';`,
  );
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  const violations = checkPackageBoundaries(repo);
  assert.deepEqual(
    violations.map((item) => item.line),
    [2, 3, 4],
  );
  assert.match(violations[0]!.message, /bypasses the package boundary/);
  assert.match(violations[1]!.message, /unknown workspace package/);
  assert.match(violations[2]!.message, /not named by .*exports/);
});
