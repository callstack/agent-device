import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveImportEdges } from './model.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { listTrackedTypeScriptFiles } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

test('snapshot presentation cannot import daemon assembly', () => {
  const files = listTrackedTypeScriptFiles(repoRoot);
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  const violations = resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot)).filter(
    (edge) =>
      edge.file.startsWith('src/snapshot/snapshot-presentation/') &&
      edge.target.startsWith('src/daemon/'),
  );

  assert.deepEqual(
    violations.map((edge) => `${edge.file}:${edge.line} -> ${edge.target}`),
    [],
    'the snapshot presentation facet must not depend on daemon assembly',
  );
});
