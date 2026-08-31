import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  ARCHITECTURE_OWNERSHIP,
  matchesDeclaredRoot,
  SESSION_LIFECYCLE_RETIRED_HANDLER_PATHS,
} from './architecture-ownership.ts';
import { readNamedExports } from './facade-exports.ts';
import { resolveImportEdges } from './model.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { listTrackedTypeScriptFiles } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

function productionFile(file: string): boolean {
  return !file.endsWith('.test.ts') && !file.includes('/__tests__/');
}

test('architecture ownership roots resolve to tracked owners', () => {
  const tracked = new Set(listTrackedTypeScriptFiles(repoRoot));

  for (const declaration of [
    ...ARCHITECTURE_OWNERSHIP.logicalModules,
    ...ARCHITECTURE_OWNERSHIP.executablePolicies,
  ]) {
    for (const root of declaration.roots) {
      assert.ok(
        [...tracked].some((file) => matchesDeclaredRoot(file, root)),
        `${declaration.name} has no tracked root: ${root}`,
      );
    }
  }
  for (const declaration of ARCHITECTURE_OWNERSHIP.vocabulary) {
    for (const root of declaration.roots) {
      assert.ok(tracked.has(root), `${declaration.name} root is not tracked: ${root}`);
    }
  }
  for (const declaration of ARCHITECTURE_OWNERSHIP.capabilities) {
    assert.ok(tracked.has(declaration.root), `${declaration.name} root is not tracked`);
  }
  for (const declaration of ARCHITECTURE_OWNERSHIP.liveState) {
    assert.ok(tracked.has(declaration.root), `${declaration.name} root is not tracked`);
  }
});

test('logical module façades pin their named command surfaces', () => {
  const tracked = new Set(listTrackedTypeScriptFiles(repoRoot));

  for (const declaration of ARCHITECTURE_OWNERSHIP.facades) {
    assert.ok(tracked.has(declaration.root), `${declaration.name} root is not tracked`);
    const source = fs.readFileSync(path.join(repoRoot, declaration.root), 'utf8');
    assert.deepEqual(
      readNamedExports(source),
      declaration.exports,
      `${declaration.name} façade exports drifted`,
    );
  }
});

test('session lifecycle retires its handler-owned helper paths', () => {
  const tracked = new Set(listTrackedTypeScriptFiles(repoRoot));
  for (const retiredPath of SESSION_LIFECYCLE_RETIRED_HANDLER_PATHS) {
    assert.equal(tracked.has(retiredPath), false, `retired path was restored: ${retiredPath}`);
  }
});

test('vocabulary roots are exported contract facades', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(repoRoot, 'packages/contracts/package.json'), 'utf8'),
  ) as { exports: Record<string, { default: string }> };
  const publicSources = new Set(
    Object.values(manifest.exports).map(({ default: source }) =>
      path.posix.join('packages/contracts', source.slice(2)),
    ),
  );

  for (const declaration of ARCHITECTURE_OWNERSHIP.vocabulary) {
    for (const root of declaration.roots) {
      assert.ok(publicSources.has(root), `${declaration.name} is not a public contract facade`);
    }
  }
});

test('capability roots enumerate current exports and have production consumers', () => {
  const files = listTrackedTypeScriptFiles(repoRoot);
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  const edges = resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot));

  for (const declaration of ARCHITECTURE_OWNERSHIP.capabilities) {
    assert.deepEqual(
      readNamedExports(sources.get(declaration.root)!),
      declaration.exports,
      `${declaration.name} capability exports drifted`,
    );
    assert.ok(
      edges.some((edge) => edge.target === declaration.root && productionFile(edge.file)),
      `${declaration.name} has no production consumer`,
    );
  }
});

test('live-state roots enumerate their declared exports', () => {
  const files = listTrackedTypeScriptFiles(repoRoot);
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );

  for (const declaration of ARCHITECTURE_OWNERSHIP.liveState) {
    const actual = new Set(readNamedExports(sources.get(declaration.root)!));
    for (const name of declaration.exports) {
      assert.equal(actual.has(name), true, `${declaration.name} export drifted: ${name}`);
    }
  }
});

test('lookalike paths and symbols remain undeclared', () => {
  const client = ARCHITECTURE_OWNERSHIP.vocabulary.find(({ name }) => name === 'client-contract')!;
  const capability = ARCHITECTURE_OWNERSHIP.capabilities.find(
    ({ name }) => name === 'request-runtime-binding',
  )!;

  assert.equal(matchesDeclaredRoot(`${client.roots[0]}-extra`, client.roots[0]), false);
  assert.equal(matchesDeclaredRoot('src/snapshot-policy.ts', 'src/snapshot/'), false);
  assert.equal(matchesDeclaredRoot(`${capability.root}.bak`, capability.root), false);
  assert.equal(capability.exports.includes('createRequestRuntimeBindingsExtra'), false);
});
