import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { executablePolicyViolations } from './executable-policies.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { listTrackedTypeScriptFiles } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');

/**
 * The `snapshot-policy` declaration owns presentation, freshness, timeout and overlay policy;
 * `packages/daemon/src/` owns the assembly that orders them (#1983, ADR 0004 "Ownership"). The dependency runs one way
 * only, so a policy stays testable without standing up a session.
 *
 * The real tree is clean, which is exactly why the positive control below exists: a filter that
 * stopped matching would look identical to a boundary being obeyed.
 */
test('the snapshot facet cannot import daemon assembly', () => {
  const files = listTrackedTypeScriptFiles(repoRoot);
  const sources = new Map(
    files.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );

  assert.deepEqual(
    executablePolicyViolations(sources, workspaceSpecifierTargets(repoRoot))['snapshot-policy'],
    [],
    'the host-side snapshot facet must not depend on daemon assembly',
  );
});

test('the boundary reports a facet module that reaches back into the daemon', () => {
  const sources = new Map([
    ['packages/daemon/src/types.ts', 'export type SessionState = { id: string };\n'],
    [
      'packages/capture-kit/src/snapshot/snapshot-freshness/android.ts',
      "import type { SessionState } from '../../../../../packages/daemon/src/types.ts';\nexport type X = SessionState;\n",
    ],
  ]);

  assert.deepEqual(executablePolicyViolations(sources)['snapshot-policy'], [
    'packages/capture-kit/src/snapshot/snapshot-freshness/android.ts:1 -> packages/daemon/src/types.ts',
  ]);
});
