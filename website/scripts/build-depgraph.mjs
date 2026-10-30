import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brandCss } from '../src/site/brand.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const output = path.join(root, 'website/dist/depgraph');
const viewer = path.join(root, 'tools/depgraph-view');
// Vercel can omit .git from the build input. Index the clean checkout in a temporary
// repository so the graph still uses the layering scan's tracked-file selection.
let temporaryGit;
const env = { ...process.env };

try {
  if (process.env.VERCEL && !existsSync(path.join(root, '.git'))) {
    temporaryGit = mkdtempSync(path.join(os.tmpdir(), 'depgraph-git-'));
    execFileSync('git', ['init', '--bare', '--quiet', temporaryGit]);
    env.GIT_DIR = temporaryGit;
    env.GIT_WORK_TREE = root;
    // tracked-sources.ts limits production sources and package manifests to these roots.
    execFileSync('git', ['add', '--', 'src', 'packages'], { cwd: root, env });
  }

  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, 'brand.css'), brandCss);
  cpSync(path.join(root, 'website/src/fonts'), path.join(output, 'fonts'), { recursive: true });
  const html = readFileSync(path.join(viewer, 'index.html'), 'utf8');
  writeFileSync(
    path.join(output, 'index.html'),
    html.replace(
      '</head>',
      '<link rel="stylesheet" href="./brand.css" /><link rel="stylesheet" href="./fonts/font-face.css" /></head>',
    ),
  );
  for (const file of readdirSync(viewer).filter((name) => name.endsWith('.js')))
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
} catch (error) {
  process.stderr.write(
    `depgraph build failed: ${error instanceof Error ? error.message : error}\n`,
  );
  process.exitCode = 1;
} finally {
  if (temporaryGit) rmSync(temporaryGit, { recursive: true, force: true });
}
