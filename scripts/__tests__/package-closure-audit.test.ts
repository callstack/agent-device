/**
 * Behavioral tests for the publishing gate's dependency-closure audit, run against fixture packages
 * that stand in for packed output.
 *
 * The gate itself (scripts/check-package.ts) needs a real `npm pack` behind minutes of Swift and
 * Android builds, so every check that runs it can only observe a *healthy* package passing. That
 * leaves the interesting direction — does a malformed package actually fail? — untested, which is
 * how the audit came to read 0 of the 99 dynamic imports in the built bundle while looking covered.
 * These fixtures assert the failure direction, one resolution form at a time.
 *
 * Each fixture is spelled the way the minifier spells it: no-substitution template literals, short
 * aliased `createRequire` bindings. That is what the packed files look like, so that is what the
 * audit has to be able to read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'vitest';
import { auditDependencyClosure, type PackedManifest } from '../lib/shipped-imports.ts';

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Lays out a fake installed package: shipped files plus the `dependencies` the manifest declares. */
function fixturePackage(files: Record<string, string>, dependencies: string[] = []): () => void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-closure-fixture-'));
  tempRoots.push(root);
  for (const [relative, source] of Object.entries(files)) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, source);
  }
  const manifest: PackedManifest = {
    dependencies: Object.fromEntries(dependencies.map((name) => [name, '1.0.0'])),
  };
  return () => void auditDependencyClosure(root, manifest);
}

/** The workspace-private specifier whose published import broke 0.20.4 (#1577). */
const PRIVATE = '@agent-device/ad-script';

/** Every literal spelling of "resolve this specifier at runtime" that a shipped file can use. */
const LAZY_FORMS: Record<string, string> = {
  'dynamic import, minified backtick spelling': 'await import(`SPECIFIER`);',
  'dynamic import, quoted spelling': "await import('SPECIFIER');",
  'bare require': 'const mod = require(`SPECIFIER`);',
  'require.resolve': 'const at = require.resolve(`SPECIFIER`);',
  'aliased createRequire result': [
    "import { createRequire as t } from 'node:module';",
    'var a = t(import.meta.url);',
    'const mod = a(`SPECIFIER`);',
  ].join('\n'),
  'immediately invoked createRequire': [
    "import { createRequire } from 'node:module';",
    'const mod = createRequire(import.meta.url)(`SPECIFIER`);',
  ].join('\n'),
  'createRequire through a namespace import': [
    "import * as M from 'node:module';",
    'var r = M.createRequire(import.meta.url);',
    'const mod = r(`SPECIFIER`);',
  ].join('\n'),
  'require alias declared below its use': [
    "import { createRequire as t } from 'node:module';",
    'export function load() { return q(`SPECIFIER`); }',
    'var q = t(import.meta.url);',
  ].join('\n'),
};

// The reviewable claim of the gate: a shipped file cannot reach a package the manifest does not
// declare. Without every form below, a command could lazily resolve a workspace-private specifier
// and publish green — the 0.20.4 failure class, reintroduced one resolution form at a time.
for (const [form, template] of Object.entries(LAZY_FORMS)) {
  test(`an undeclared private specifier fails the closure audit via ${form}`, () => {
    const audit = fixturePackage({ 'dist/cli.js': template.replaceAll('SPECIFIER', PRIVATE) });
    assert.throws(audit, (error: Error) => {
      assert.match(error.message, /Imported but not declared in "dependencies"/);
      assert.match(error.message, /@agent-device\/ad-script in dist\/cli\.js/);
      return true;
    });
  });

  test(`a declared dependency satisfies the closure audit via ${form}`, () => {
    const audit = fixturePackage({ 'dist/cli.js': template.replaceAll('SPECIFIER', 'yaml') }, [
      'yaml',
    ]);
    audit();
  });
}

test('a subpath import is attributed to the package that must be declared', () => {
  const audit = fixturePackage({ 'dist/cli.js': 'await import(`@limrun/api/client`);' }, [
    '@limrun/api',
  ]);
  audit();
});

test('the audit reads every shipped extension, not only the bundled .js files', () => {
  for (const file of ['bin/agent-device.mjs', 'dist/legacy.cjs', 'dist/index.d.ts']) {
    const audit = fixturePackage({ [file]: `const mod = require(\`${PRIVATE}\`);` });
    assert.throws(
      audit,
      new RegExp(`${PRIVATE.replace('/', '\\/')} in ${file.replace('/', '\\/')}`),
    );
  }
});

test('builtins and relative specifiers are not dependencies', () => {
  const audit = fixturePackage({
    'dist/cli.js': [
      "import fs from 'node:fs';",
      "import { createRequire as t } from 'node:module';",
      'var a = t(import.meta.url);',
      'const z = a(`zlib`);',
      'const u = a(`util`);',
      'await import(`./sibling.js`);',
      'await import(`../parent.js`);',
    ].join('\n'),
    'dist/sibling.js': 'export const x = 1;',
  });
  audit();
});

// The other direction of the same audit: a dependency every user installs and no shipped file
// reaches. How `pngjs` stayed in `dependencies` after tsdown started inlining it.
test('a declared dependency nothing imports fails the closure audit', () => {
  const audit = fixturePackage({ 'dist/cli.js': 'export const x = 1;' }, ['pngjs']);
  assert.throws(audit, /Declared in "dependencies" but never imported[\s\S]*- pngjs/);
});

// Pinned limitations, so the gate's guarantee stays honest about where it stops. Both are covered
// by the runtime half instead: the gate imports every export and runs the CLI paths that load the
// lazy bundles, which resolves computed specifiers for real.
test('a computed specifier is out of scope for the static audit', () => {
  const audit = fixturePackage({
    'dist/cli.js': [
      "import { createRequire as t } from 'node:module';",
      'var a = t(import.meta.url);',
      'export const load = (name) => a(name);',
      'export const scoped = (v) => require(`@agent-device/ad-` + v);',
      'export const lazy = (name) => import(name);',
    ].join('\n'),
  });
  audit();
});

test('a minified name collision is not mistaken for a require call', () => {
  // The packed png-worker-contract.js really does contain `a(h[t],f,g,l,e,m)` in a scope where `a`
  // is not the file's `createRequire` result. Attributing that to a dependency would fail the gate
  // on a sound package, so only the one-string-argument shape counts.
  const audit = fixturePackage({
    'dist/cli.js': [
      "import { createRequire as t } from 'node:module';",
      'var a = t(import.meta.url);',
      'export function draw(h, f, g, l, e, m) {',
      '  const a = (...parts) => parts.length;',
      '  return a(h[0], f, g, l, e, m);',
      '}',
    ].join('\n'),
  });
  audit();
});
