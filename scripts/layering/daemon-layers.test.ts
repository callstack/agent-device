import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import { resolveImportEdges, type ResolvedImportEdge } from './model.ts';
import {
  checkDaemonLayers,
  DAEMON_LAYER_ORDER,
  DAEMON_ROOT,
  daemonLayerOf,
} from './daemon-layers.ts';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim();

// Fixtures sit at the real layer folders so the folder-derived lookup treats them like
// production files; `listSourceFiles()` keeps the tree half honest against the tracked tree.
const FIXTURE_FILES = DAEMON_LAYER_ORDER.map((layer) => `${DAEMON_ROOT}/${layer}/index.ts`);

function fixtureEdges(sources: ReadonlyMap<string, string>): ResolvedImportEdge[] {
  const empty = new Map(FIXTURE_FILES.map((file) => [file, ''] as const));
  return resolveImportEdges(new Map([...empty, ...sources]));
}

const core = `${DAEMON_ROOT}/core/index.ts`;
const resources = `${DAEMON_ROOT}/resources/index.ts`;
const server = `${DAEMON_ROOT}/server/index.ts`;
const sessions = `${DAEMON_ROOT}/sessions/index.ts`;

test('every tracked daemon production file resolves to a layer folder, and no static edge reads upward', () => {
  const daemonFiles = listSourceFiles().filter((file) => file.startsWith(`${DAEMON_ROOT}/`));
  assert.ok(daemonFiles.length > 0, 'expected daemon production files to scan');
  assert.deepEqual(
    daemonFiles.filter((file) => daemonLayerOf(file) === null),
    [],
  );

  // End-to-end over the real daemon subgraph: every edge whose two ends are layer-folder files.
  const sources = new Map(
    daemonFiles.map((file) => [file, fs.readFileSync(path.join(repoRoot, file), 'utf8')]),
  );
  const reported: string[] = [];
  const violations = checkDaemonLayers(daemonFiles, resolveImportEdges(sources), (line) =>
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
    fixtureEdges(new Map([[core, `import { thing } from '../resources/index.ts';`]])),
    () => {},
  );
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, 'R81 daemon-layers');
  assert.equal(violations[0]!.file, core);
  assert.match(violations[0]!.message, /value import reads up the daemon layer order/);
});

test('an upward type-only import fails the layer order too', () => {
  const violations = checkDaemonLayers(
    FIXTURE_FILES,
    fixtureEdges(new Map([[resources, `import type { Thing } from '../sessions/index.ts';`]])),
    () => {},
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /type-only import reads up the daemon layer order/);
});

test('a nested file reads up from its layer folder and fails', () => {
  const nested = `${DAEMON_ROOT}/core/device/ready.ts`;
  const violations = checkDaemonLayers(
    [...FIXTURE_FILES, nested],
    resolveImportEdges(
      new Map([
        [nested, `import { thing } from '../../server/index.ts';`],
        ...FIXTURE_FILES.map((file) => [file, ''] as const),
      ]),
    ),
    () => {},
  );
  assert.equal(violations.length, 1);
  assert.match(violations[0]!.message, /\(core\) imports .+ \(server\)/);
});

test('downward and same-layer static edges stay silent', () => {
  const violations = checkDaemonLayers(
    FIXTURE_FILES,
    fixtureEdges(
      new Map([
        [server, `import { thing } from '../core/index.ts';`],
        [sessions, `import type { CoreThing } from '../core/index.ts';`],
      ]),
    ),
    () => {},
  );
  assert.deepEqual(violations, []);
});

test('a dynamic cross-layer edge is reported, not rejected', () => {
  const reported: string[] = [];
  const violations = checkDaemonLayers(
    FIXTURE_FILES,
    fixtureEdges(new Map([[sessions, `void import('../server/index.ts');`]])),
    (line) => reported.push(line),
  );
  assert.deepEqual(violations, []);
  assert.equal(reported.length, 2);
  assert.match(reported.join(''), /1 dynamic cross-layer daemon edge/);
  assert.match(
    reported.join(''),
    new RegExp(
      `${DAEMON_ROOT}/sessions/index\\.ts \\(sessions\\) -> ` +
        `${DAEMON_ROOT}/server/index\\.ts \\(server\\) \\[upward, reported only\\]`,
    ),
  );
});

test('an empty daemon file set fails: a stale scan filter must not pass the rule silently', () => {
  // The caller filters sourceFiles by DAEMON_ROOT; a call site that hardcodes a stale root
  // hands the rule nothing. That must be a violation, not a green run.
  const violations = checkDaemonLayers([], [], () => {});
  assert.equal(violations.length, 1);
  assert.equal(violations[0]!.rule, 'R81 daemon-layers');
  assert.match(violations[0]!.message, /received no tracked production files/);
});

test('a production file at the daemon root fails: the folder is the declaration', () => {
  const orphans = [`${DAEMON_ROOT}/stray.ts`, `${DAEMON_ROOT}/newzone/thing.ts`];
  const violations = checkDaemonLayers([...FIXTURE_FILES, ...orphans], [], () => {});
  assert.equal(violations.length, 2);
  assert.deepEqual(
    violations.map((violation) => violation.file),
    orphans,
  );
  assert.match(violations[0]!.message, /is not under a layer folder/);
  assert.match(violations[1]!.message, /does not start with one/);
});

test('tests and test support carry no layer and never trip the folder claim', () => {
  const testSide = [
    `${DAEMON_ROOT}/core/__tests__/thing.test.ts`,
    `${DAEMON_ROOT}/__tests__/support/store-factory.ts`,
    `${DAEMON_ROOT}/stray-territory/thing.test.ts`,
  ];
  assert.deepEqual(
    checkDaemonLayers(testSide, [], () => {}),
    [],
  );
  for (const file of testSide) assert.equal(daemonLayerOf(file), null);
});
