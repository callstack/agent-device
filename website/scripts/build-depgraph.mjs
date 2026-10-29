import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'website/dist/dependency-graph');
const viewer = path.join(root, 'tools/depgraph-view');
// Vercel can omit .git from the build input. Index the clean checkout in a temporary
// repository so the graph still uses the layering scan's tracked-file selection.
let temporaryGit;
const env = { ...process.env };
if (process.env.VERCEL && !existsSync(path.join(root, '.git'))) {
  temporaryGit = mkdtempSync(path.join(os.tmpdir(), 'depgraph-git-'));
  execFileSync('git', ['init', '--bare', '--quiet', temporaryGit]);
  env.GIT_DIR = temporaryGit;
  env.GIT_WORK_TREE = root;
  execFileSync('git', ['add', '--', 'src', 'packages'], { cwd: root, env });
}

try {
  mkdirSync(output, { recursive: true });
  for (const file of ['index.html', 'app.js', 'layout.js', 'analysis.js', 'graph-model.js'])
    copyFileSync(path.join(viewer, file), path.join(output, file));
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/depgraph/build.ts',
      '--out',
      path.join(output, 'graph.json'),
    ],
    { cwd: root, env, stdio: 'inherit' },
  );
  execFileSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'tools/depgraph-view/build-entries.mjs',
      '--graph',
      path.join(output, 'graph.json'),
      '--out',
      path.join(output, 'entries.json'),
    ],
    { cwd: root, env, stdio: 'inherit' },
  );
} finally {
  if (temporaryGit) rmSync(temporaryGit, { recursive: true, force: true });
}
