import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'vitest';

const repoRoot = process.cwd();

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
  exports: Record<string, { import: string; types: string }>;
};

// The tsdown build is what actually emits the files package.json points at, so a
// subpath only reaches the npm tarball when both agree on the same source entry.
// Loaded via a runtime path so its build-tooling types stay out of the program.
const tsdownConfig = (await import(
  pathToFileURL(path.join(repoRoot, 'tsdown.config.ts')).href
)) as {
  default: { entry?: Record<string, string> };
};
const buildEntries = tsdownConfig.default.entry ?? {};

const supportedSubpaths = [
  '.',
  './io',
  './artifacts',
  './metro',
  './batch',
  './remote-config',
  './install-source',
  './android-adb',
  './contracts',
  './selectors',
  './finders',
];
const typeOnlySubpaths = new Set(['./remote-config']);

function exportTarget(subpath: string): { import: string; types: string } {
  const target = pkg.exports[subpath];
  assert.ok(target, `${subpath} should be exported`);
  return target;
}

// Resolve `./dist/src/<name>.js` back to the tsdown entry key (`<name>`).
function entryKeyForDist(distImportPath: string): string {
  const key = distImportPath.match(/^\.\/dist\/src\/(.+)\.js$/)?.[1];
  assert.ok(key, `Unexpected export target shape: ${distImportPath}`);
  return key;
}

// The repo-relative source file the tsdown build compiles for this subpath.
function sourcePathFor(subpath: string): string {
  const entryKey = entryKeyForDist(exportTarget(subpath).import);
  const entry = buildEntries[entryKey];
  assert.ok(
    entry,
    `exports["${subpath}"] needs a tsdown build entry "${entryKey}" to reach the npm tarball`,
  );
  return path.join(repoRoot, entry);
}

test('package exports only supported public subpaths', () => {
  for (const subpath of supportedSubpaths) {
    assert.equal(pkg.exports[subpath] !== undefined, true, `${subpath} should be exported`);
  }

  assert.equal(pkg.exports['./android-apps'], undefined);
  assert.equal(pkg.exports['./daemon'], undefined);
});

test('every public subpath is backed by a configured tsdown build entry', () => {
  for (const subpath of supportedSubpaths) {
    const sourcePath = sourcePathFor(subpath);
    assert.ok(
      fs.existsSync(sourcePath),
      `exports["${subpath}"] source ${sourcePath} does not exist`,
    );
  }
});

test('every public subpath ships matching import and types targets', () => {
  for (const subpath of supportedSubpaths) {
    const target = exportTarget(subpath);
    assert.equal(
      target.types,
      target.import.replace(/\.js$/, '.d.ts'),
      `exports["${subpath}"] import and types targets are out of sync`,
    );
  }
});

test('every public subpath resolves to a module that exposes named exports', async () => {
  for (const subpath of supportedSubpaths) {
    if (typeOnlySubpaths.has(subpath)) continue;
    const sourcePath = sourcePathFor(subpath);
    const module = (await import(pathToFileURL(sourcePath).href)) as Record<string, unknown>;
    const namedExports = Object.keys(module).filter((name) => name !== 'default');
    assert.ok(
      namedExports.length > 0,
      `exports["${subpath}"] resolves to a module with no named exports`,
    );
  }
});
