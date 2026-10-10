import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import { resolveImportEdges, type ResolvedImportEdge } from './model.ts';
import {
  checkDaemonLayers,
  daemonLayerManifestDrift,
  DAEMON_LAYER_ORDER,
  readDaemonLayerManifest,
} from './daemon-layers.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

// Fixtures sit at the real daemon paths so the layer lookup treats them like production files;
// `listSourceFiles()` keeps the manifest half honest against the tracked tree.
const FIXTURE_MANIFEST = {
  'daemon-core': ['src/daemon/core.ts'],
  'daemon-resources': ['src/daemon/resources.ts'],
  'daemon-execution': ['src/daemon/execution.ts'],
  'daemon-sessions': ['src/daemon/sessions.ts'],
  'daemon-server': ['src/daemon/server.ts'],
};
const FIXTURE_FILES = Object.values(FIXTURE_MANIFEST).flat();

function fixtureEdges(sources: ReadonlyMap<string, string>): ResolvedImportEdge[] {
  const empty = new Map(FIXTURE_FILES.map((file) => [file, ''] as const));
  return resolveImportEdges(new Map([...empty, ...sources]));
}

function driftFor(
  manifest: Record<string, readonly string[]>,
  files: readonly string[] = FIXTURE_FILES,
) {
  return daemonLayerManifestDrift(files, manifest);
}

test('the manifest owns every tracked daemon file exactly once, and no static edge reads upward', () => {
  const daemonFiles = listSourceFiles().filter((file) => file.startsWith('src/daemon/'));
  assert.ok(daemonFiles.length > 0, 'expected daemon production files to scan');
  const manifest = readDaemonLayerManifest(repoRoot);
  assert.deepEqual(Object.keys(manifest).sort(), [...DAEMON_LAYER_ORDER].sort());
  assert.deepEqual(daemonLayerManifestDrift(daemonFiles, manifest), []);

  // End-to-end over the real daemon subgraph: every edge whose two ends are manifest files.
  const sources = new Map(
    daemonFiles.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  const reported: string[] = [];
  const violations = checkDaemonLayers(daemonFiles, resolveImportEdges(sources), manifest, (line) =>
    reported.push(line),
  );
  assert.deepEqual(violations, []);
  // The dynamic report names the lazy handler-chain seams, all of them reading downward.
  assert.match(reported.join(''), /dynamic cross-layer daemon edge/);
  assert.ok(!reported.join('').includes('[upward'), 'dynamic cross-layer edges stay downward');
});

test('an upward value import fails the layer order', () => {
  const violations = checkDaemonLayers(
    FIXTURE_FILES,
    fixtureEdges(new Map([['src/daemon/core.ts', "import { thing } from './resources.ts';"]])),
    FIXTURE_MANIFEST,
    () => {},
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, 'R81 daemon-layers');
  assert.equal(violations[0]!.file, 'src/daemon/core.ts');
  assert.match(violations[0]!.message, /value import reads up the daemon layer order/);
});

test('an upward type-only import fails the layer order too', () => {
  const violations = checkDaemonLayers(
    FIXTURE_FILES,
    fixtureEdges(
      new Map([['src/daemon/resources.ts', "import type { Thing } from './sessions.ts';"]]),
    ),
    FIXTURE_MANIFEST,
    () => {},
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /type-only import reads up the daemon layer order/);
});

test('downward and same-layer static edges stay silent', () => {
  const violations = checkDaemonLayers(
    FIXTURE_FILES,
    fixtureEdges(
      new Map([
        ['src/daemon/server.ts', "import { thing } from './core.ts';"],
        ['src/daemon/sessions.ts', "import type { CoreThing } from './core.ts';"],
      ]),
    ),
    FIXTURE_MANIFEST,
    () => {},
  );
  assert.deepEqual(violations, []);
});

test('a dynamic cross-layer edge is reported, not rejected', () => {
  const reported: string[] = [];
  const violations = checkDaemonLayers(
    FIXTURE_FILES,
    fixtureEdges(new Map([['src/daemon/sessions.ts', "void import('./server.ts');"]])),
    FIXTURE_MANIFEST,
    (line) => reported.push(line),
  );
  assert.deepEqual(violations, []);
  assert.equal(reported.length, 2);
  assert.match(reported.join(''), /1 dynamic cross-layer daemon edge/);
  assert.match(
    reported.join(''),
    /src\/daemon\/sessions\.ts \(daemon-sessions\) -> src\/daemon\/server\.ts \(daemon-server\) \[upward, reported only\]/,
  );
});

test('a production daemon file missing from the manifest fails', () => {
  const manifest = {
    ...FIXTURE_MANIFEST,
    'daemon-server': [],
  };
  const violations = driftFor(manifest);
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.file, 'src/daemon/server.ts');
  assert.match(violations[0]!.message, /production daemon file is in no layer/);
});

test('a file claimed by two layers fails', () => {
  const manifest = {
    ...FIXTURE_MANIFEST,
    'daemon-resources': ['src/daemon/resources.ts', 'src/daemon/core.ts'],
  };
  const violations = driftFor(manifest);
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /"src\/daemon\/core\.ts" is claimed by more than one layer/);
});

test('a manifest entry that is not a tracked production file fails', () => {
  const manifest = {
    ...FIXTURE_MANIFEST,
    'daemon-core': ['src/daemon/core.ts', 'src/daemon/gone.ts'],
  };
  const violations = driftFor(manifest);
  assert.equal(violations.length, 1);
  assert.match(
    violations[0]!.message,
    /"src\/daemon\/gone\.ts" is owned by "daemon-core" but is not a tracked production file/,
  );
});

test('a test, fixture, or foreign path in the manifest fails as a non-production entry', () => {
  const manifest = {
    ...FIXTURE_MANIFEST,
    'daemon-core': [
      'src/daemon/core.ts',
      'src/daemon/__tests__/core.test.ts',
      'src/core/helper.ts',
    ],
  };
  const violations = driftFor(manifest);
  assert.equal(violations.length, 2);
  for (const violation of violations) {
    assert.match(violation.message, /is not a production path under src\/daemon\/\./);
  }
});

test('an unknown layer key fails, naming the declared order', () => {
  const violations = driftFor({
    ...FIXTURE_MANIFEST,
    'daemon-cache': [],
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /unknown daemon layer "daemon-cache"/);
});

test('a layer key missing from the manifest fails even when no file is orphaned', () => {
  const manifest = { ...FIXTURE_MANIFEST } as Record<string, readonly string[]>;
  delete manifest['daemon-resources'];
  const violations = driftFor(
    manifest,
    FIXTURE_FILES.filter((file) => file !== 'src/daemon/resources.ts'),
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /layer "daemon-resources" is missing from the manifest/);
});
