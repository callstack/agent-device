import fs from 'node:fs';
import path from 'node:path';
import { mkdtempForTestSync } from './internal/tmp-dir.fixtures.ts';

/**
 * A temporary checkout root named the way a real one is: with its symlinks
 * resolved. A production root comes from `import.meta.url`, which the loader
 * resolved before the walk ever sees it. On macOS `os.tmpdir()` is `/tmp`,
 * itself a link to `/private/tmp`, so an unresolved fixture root would be a
 * shape no caller passes — and the shape every fixture passed. Naming a root
 * through a link is covered on purpose instead, by its own test.
 */
export function createCheckoutRootForTest(prefix: string): string {
  return fs.realpathSync.native(mkdtempForTestSync(prefix));
}

/**
 * A source checkout that imports its own implementation the way this one does:
 * an entry under `src/`, a workspace package under `packages/`, and the
 * `node_modules` link that makes `@scope/pkg` name it. The link is what
 * separates a workspace package from an installed dependency, so a fixture
 * that wrote the directory in place instead would be testing nothing.
 */
export function writeWorkspaceFixture(prefix: string): {
  root: string;
  entryPath: string;
  packageDir: string;
  manifestPath: string;
  ownedPath: string;
} {
  const root = createCheckoutRootForTest(prefix);
  const entryPath = path.join(root, 'src', 'daemon.ts');
  const packageDir = path.join(root, 'packages', 'kit');
  const ownedPath = path.join(packageDir, 'src', 'owned.ts');
  const manifestPath = path.join(packageDir, 'package.json');

  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.mkdirSync(path.dirname(ownedPath), { recursive: true });
  fs.writeFileSync(entryPath, "import '@scope/kit/owned';\n", 'utf8');
  fs.writeFileSync(ownedPath, 'export const owned = 1;\n', 'utf8');
  fs.writeFileSync(
    manifestPath,
    JSON.stringify({
      name: '@scope/kit',
      exports: { './owned': { types: './src/owned.ts', default: './src/owned.ts' } },
    }),
    'utf8',
  );

  const linkDir = path.join(root, 'node_modules', '@scope');
  fs.mkdirSync(linkDir, { recursive: true });
  fs.symlinkSync(packageDir, path.join(linkDir, 'kit'), 'dir');
  return { root, entryPath, packageDir, manifestPath, ownedPath };
}

/**
 * A checkout whose `@scope/vendor` is installed rather than linked: the
 * package directory is written inside `node_modules` in place, which is the
 * whole difference the walk keys the two cases on.
 */
export function writeInstalledDependencyFixture(prefix: string): {
  root: string;
  entryPath: string;
} {
  const root = createCheckoutRootForTest(prefix);
  const entryPath = path.join(root, 'src', 'daemon.ts');
  const packageDir = path.join(root, 'node_modules', '@scope', 'vendor');

  fs.mkdirSync(path.dirname(entryPath), { recursive: true });
  fs.mkdirSync(path.join(packageDir, 'src'), { recursive: true });
  fs.writeFileSync(entryPath, "import '@scope/vendor/thing';\n", 'utf8');
  fs.writeFileSync(path.join(packageDir, 'src', 'thing.js'), 'export const thing = 1;\n', 'utf8');
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@scope/vendor', exports: { './thing': './src/thing.js' } }),
    'utf8',
  );
  return { root, entryPath };
}
