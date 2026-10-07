/**
 * Creates a minimal git fixture repository (tracked demo package + scratch helpers) used by the
 * eager-closure gate tests. Returns the repo root. Everything committed here is TRACKED, so
 * anything a caller writes afterwards is by definition uncommitted scratch.
 *
 * Lives beside the gate tests that use it (`eager-closure-budgets.test.ts`,
 * `closure-growth-rule.test.ts`). A real git repo rather than a bare tmpdir because
 * tracked-vs-untracked only exists relative to git, following
 * `scripts/layering/platform-package-repository.test.ts`.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A committed fixture repository: one workspace package with a manifest export target, a
 * top-level façade, a nested façade, and a test source.
 */
export function mkGitFixtureRepo(prefix: string): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const pkgDir = path.join(repo, 'packages/demo');
  fs.mkdirSync(path.join(pkgDir, 'src/facades/nested'), { recursive: true });
  fs.writeFileSync(
    path.join(pkgDir, 'package.json'),
    JSON.stringify({
      name: '@agent-device/demo',
      exports: { '.': './src/entry.ts' },
    }),
  );
  fs.writeFileSync(path.join(pkgDir, 'src/entry.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/top.ts'), 'export const b = 2;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/nested/deep.ts'), 'export const c = 3;\n');
  fs.writeFileSync(path.join(pkgDir, 'src/facades/skip.test.ts'), 'export const d = 4;\n');
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.writeFileSync(path.join(repo, 'scripts/standalone.ts'), 'export const outside = 1;\n');
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync(
    'git',
    ['-c', 'user.name=Gate', '-c', 'user.email=gate@example.test', 'commit', '-qm', 'base'],
    { cwd: repo },
  );
  return repo;
}
