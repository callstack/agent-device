import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { resolveImportEdges } from './model.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { listTrackedTypeScriptFiles } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * The host-side snapshot facet (`src/snapshot/`) owns presentation, freshness, timeout and
 * overlay policy; `src/daemon/` owns the assembly that orders them (#1983, ADR 0004). The
 * dependency runs one way only, so a policy stays testable without standing up a session.
 *
 * The real tree is clean, which is exactly why the positive control below exists: a filter that
 * stopped matching would look identical to a boundary being obeyed.
 */
function daemonImportsFromSnapshotFacet(
  sources: ReadonlyMap<string, string>,
  workspaceTargets?: ReadonlyMap<string, string>,
): string[] {
  return resolveImportEdges(sources, workspaceTargets)
    .filter(
      (edge) => edge.file.startsWith('src/snapshot/') && edge.target.startsWith('src/daemon/'),
    )
    .map((edge) => `${edge.file}:${edge.line} -> ${edge.target}`);
}

test('the snapshot facet cannot import daemon assembly', () => {
  const files = listTrackedTypeScriptFiles(repoRoot);
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );

  assert.deepEqual(
    daemonImportsFromSnapshotFacet(sources, workspaceSpecifierTargets(repoRoot)),
    [],
    'the host-side snapshot facet must not depend on daemon assembly',
  );
});

test('the boundary reports a facet module that reaches back into the daemon', () => {
  const sources = new Map([
    ['src/daemon/types.ts', 'export type SessionState = { id: string };\n'],
    [
      'src/snapshot/snapshot-freshness/android.ts',
      "import type { SessionState } from '../../daemon/types.ts';\nexport type X = SessionState;\n",
    ],
  ]);

  assert.deepEqual(daemonImportsFromSnapshotFacet(sources), [
    'src/snapshot/snapshot-freshness/android.ts:1 -> src/daemon/types.ts',
  ]);
});
