import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import {
  fieldClassificationDrift,
  findSessionStateWrites,
  sessionStateFields,
  SESSION_STATE_FIELD_OWNERS,
  STORE_OWNED_SESSION_STATE_FIELDS,
} from './session-state.ts';
import { uninstallableImports, zeroDepJobs } from './zero-dep-jobs.ts';
import {
  largestTypeCycleSize,
  RANKED_ZONES,
  typeInversionPair,
  UNRANKED_ZONES,
  classifyZone,
  collectBackEdges,
  collectZones,
  findValueImportCycles,
  parseImports,
  resolveImportEdges,
  unclassifiedZones,
} from './model.ts';

test('parseImports distinguishes value, type-only, dynamic, and value re-export edges', () => {
  const edges = parseImports(
    [
      "import value from './value.ts';",
      "import type { TypeA } from './types.ts';",
      "import { type TypeB, type TypeC } from './more-types.ts';",
      "import { type TypeD, runtime } from './mixed.ts';",
      "export { runtimeExport } from './exported.ts';",
      "export type { ExportedType } from './exported-types.ts';",
      "void import('./dynamic.ts');",
    ].join('\n'),
  );

  assert.deepEqual(
    edges.map(({ spec, dynamic, typeOnly }) => ({ spec, dynamic, typeOnly })),
    [
      { spec: './value.ts', dynamic: false, typeOnly: false },
      { spec: './types.ts', dynamic: false, typeOnly: true },
      { spec: './more-types.ts', dynamic: false, typeOnly: true },
      { spec: './mixed.ts', dynamic: false, typeOnly: false },
      { spec: './exported.ts', dynamic: false, typeOnly: false },
      { spec: './exported-types.ts', dynamic: false, typeOnly: true },
      { spec: './dynamic.ts', dynamic: true, typeOnly: false },
    ],
  );
});

test('value cycles fail while type-only and dynamic cycles stay outside the graph', () => {
  const valueCycle = resolveImportEdges(
    new Map([
      ['src/core/a.ts', "import '../commands/b.ts';"],
      ['src/commands/b.ts', "export { a } from '../core/a.ts';"],
    ]),
  );
  assert.deepEqual(findValueImportCycles(valueCycle), [
    ['src/commands/b.ts', 'src/core/a.ts', 'src/commands/b.ts'],
  ]);

  const nonValueCycle = resolveImportEdges(
    new Map([
      ['src/core/a.ts', "import type { B } from '../commands/b.ts';"],
      ['src/commands/b.ts', "void import('../core/a.ts');"],
    ]),
  );
  assert.deepEqual(findValueImportCycles(nonValueCycle), []);
});

test('back-edge identities follow the documented target spine', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/platforms/apple.ts', "import '../core/platform-plugin.ts';"],
      ['src/core/platform-plugin.ts', 'export const plugin = true;'],
      ['src/commands/help.ts', "import '../cli/parser.ts';"],
      ['src/cli/parser.ts', 'export const parser = true;'],
      ['src/(root-fixture)/shared.ts', "import './core/platform-plugin.ts';"],
    ]),
  );
  const actual = collectBackEdges(edges);
  assert.deepEqual(actual, {
    'commands -> cli': ['src/commands/help.ts -> src/cli/parser.ts'],
    'platforms -> core': ['src/platforms/apple.ts -> src/core/platform-plugin.ts'],
  });
});

test('neutral ownership zones reject value imports into higher layers', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/contracts/result.ts', "import '../core/result.ts';"],
      ['src/core/result.ts', 'export const result = true;'],
      ['src/request/cancel.ts', "import '../commands/cancel.ts';"],
      ['src/commands/cancel.ts', 'export const cancel = true;'],
      ['src/selectors/parse.ts', "import '../client/client.ts';"],
      ['src/client/client.ts', 'export const client = true;'],
      ['src/cli-schema/schema.ts', "import '../cli/parser.ts';"],
      ['src/cli/parser.ts', 'export const parser = true;'],
    ]),
  );

  assert.deepEqual(collectBackEdges(edges), {
    'cli-schema -> cli': ['src/cli-schema/schema.ts -> src/cli/parser.ts'],
    'contracts -> core': ['src/contracts/result.ts -> src/core/result.ts'],
    'request -> commands': ['src/request/cancel.ts -> src/commands/cancel.ts'],
    'selectors -> client': ['src/selectors/parse.ts -> src/client/client.ts'],
  });
});

test('type-only edges are ranked by R6 and ignored by R5, and vice versa', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/commands/surface.ts', "import type { Shape } from '../client/client-types.ts';"],
      ['src/client/client-types.ts', 'export type Shape = { a: 1 };'],
      ['src/contracts/value.ts', "import '../core/logic.ts';"],
      ['src/core/logic.ts', 'export const logic = true;'],
      ['src/kernel/lazy.ts', "void import('../commands/surface.ts');"],
    ]),
  );

  // The type-only inversion is invisible to R5 and caught by R6.
  assert.deepEqual(collectBackEdges(edges), {
    'contracts -> core': ['src/contracts/value.ts -> src/core/logic.ts'],
  });
  assert.deepEqual(edges.map(typeInversionPair).filter(Boolean), ['commands -> client']);

  // Neither rule ranks a dynamic import: it is a deliberate cold-start seam.
  assert.equal(
    edges.filter((edge) => edge.dynamic).every((edge) => typeInversionPair(edge) === null),
    true,
  );
});

test('ranked and unranked zones are disjoint and both non-empty', () => {
  assert.ok(RANKED_ZONES.size > 0);
  assert.ok(UNRANKED_ZONES.size > 0);
  const overlap = [...RANKED_ZONES].filter((zone) => UNRANKED_ZONES.has(zone));
  assert.deepEqual(overlap, [], 'a zone cannot be both ranked and intentionally unranked');
});

test('classifyZone separates the ranked spine from intentionally-unranked zones', () => {
  assert.equal(classifyZone('kernel'), 'ranked');
  assert.equal(classifyZone('daemon-server'), 'ranked');
  assert.equal(classifyZone('(root)'), 'unranked');
  assert.equal(classifyZone('utils'), 'ranked');
  // Every satellite zone joined the spine; only the composition root stays out, because R2
  // forbids daemon/ from importing commands/ so the files that wire them cannot be ranked.
  assert.equal(classifyZone('mcp'), 'ranked');
  assert.equal(classifyZone('snapshot'), 'ranked');
  // A zone that is neither ranked nor listed peripheral must be flagged, never
  // silently treated as back-edge-free.
  assert.equal(classifyZone('not-a-real-zone'), 'unclassified');
});

test('every production zone is deliberately classified as ranked or unranked', () => {
  // Drift guard: a new src/<folder>/ (or a daemon-client/server split) forces a
  // deliberate ranked-vs-peripheral decision here instead of silently escaping
  // spine back-edge detection. If this fails, add the new zone to TARGET_DAG_RANK
  // (ranked spine) or UNRANKED_ZONES (root/peripheral) in model.ts.
  assert.deepEqual(unclassifiedZones(listSourceFiles()), []);

  // The classification must also stay honest to the tree: every zone the model
  // names is a real production zone, so the docs cannot list a spine or peripheral
  // zone that no longer exists.
  const presentZones = collectZones(listSourceFiles());
  const namedZones = new Set([...RANKED_ZONES, ...UNRANKED_ZONES]);
  const staleNamedZones = [...namedZones].filter((zone) => !presentZones.has(zone)).sort();
  assert.deepEqual(staleNamedZones, []);
});

test('listSourceFiles includes root-level src/*.ts production files', () => {
  const files = new Set(listSourceFiles());
  for (const rootFile of ['src/cli.ts', 'src/command-catalog.ts', 'src/backend.ts']) {
    assert.ok(files.has(rootFile), `expected ${rootFile} in analyzed source files`);
  }
  assert.ok(![...files].some((file) => file.endsWith('.test.ts')));
});

test('SessionState field names come from the declaration, not a hand-kept list', () => {
  const fields = sessionStateFields(
    [
      'export type SessionState = {',
      '  name: string;',
      '  sessionScope?: {',
      "    kind: 'cwd';",
      '    id: string;',
      '  };',
      '  refFrameState?: RefFrameState;',
      '};',
      '',
      'export type Other = { notAField: string };',
    ].join('\n'),
  );
  // Nested object members are not session fields, and neighbouring types are not scanned.
  assert.deepEqual(fields, ['name', 'sessionScope', 'refFrameState']);
});

test('session-state writes are found by field, and non-daemon or undeclared names are not', () => {
  const writes = findSessionStateWrites(
    new Map([
      ['src/daemon/ref-frame.ts', "session.refFrameState = 'active';"],
      ['src/daemon/session-snapshot.ts', 'session.snapshotGeneration += 1;'],
      // the store owns the record and may write anything on it
      ['src/daemon/session-store.ts', "session.refFrameState = 'expired';"],
      // a runner session outside the daemon is a different type that happens to share a name
      ['src/platforms/apple/runner-session.ts', 'session.refFrameState = 1;'],
      // a local that is not a declared SessionState field
      ['src/daemon/audio-probe.ts', 'session.somethingElse = 1;'],
      // reads and comparisons are not writes
      ['src/daemon/handlers/find.ts', "if (session.refFrameState === 'active') return;"],
      // a write into a sub-object is not a write to the field itself
      ['src/daemon/handlers/session-open.ts', 'session.refFrameState.inner = 1;'],
      // a different binding that happens to have a matching property
      ['src/daemon/handlers/session-close.ts', "other.refFrameState = 'expired';"],
    ]),
    ['refFrameState', 'snapshotGeneration'],
  );

  assert.deepEqual(
    writes.map(({ file, field }) => `${file}:${field}`),
    ['src/daemon/ref-frame.ts:refFrameState', 'src/daemon/session-snapshot.ts:snapshotGeneration'],
  );
});

test('every assignment form is a write, including the ones a regex forgets', () => {
  // A line-based matcher has to enumerate operators, and the ones it misses are the natural
  // ways to write these: `??=` for a default on an optional field, `||=`/`&&=` for a flag.
  const forms = [
    'session.refFrameState = 1;',
    'session.refFrameState ??= 1;',
    'session.refFrameState ||= 1;',
    'session.refFrameState &&= 1;',
    'session.refFrameState += 1;',
    'session.refFrameState -= 1;',
    'session.refFrameState++;',
    '--session.refFrameState;',
    'session\n  .refFrameState = 1;',
  ];
  for (const form of forms) {
    const writes = findSessionStateWrites(new Map([['src/daemon/probe.ts', form]]), [
      'refFrameState',
    ]);
    assert.deepEqual(
      writes.map(({ field }) => field),
      ['refFrameState'],
      `expected ${JSON.stringify(form)} to count as a write`,
    );
  }
});

test('a computed session write is reported rather than silently unattributed', () => {
  const writes = findSessionStateWrites(
    new Map([['src/daemon/probe.ts', 'session[key] = 1;\nsession[`refFrameState`] = 2;']]),
    ['refFrameState'],
  );
  // `[computed]` has no entry in SESSION_STATE_FIELD_OWNERS, so R7 fails on it by
  // construction — a computed write can never pass as an owned one.
  assert.deepEqual(
    writes.map(({ field }) => field),
    ['[computed]', '[computed]'],
  );
  assert.equal(SESSION_STATE_FIELD_OWNERS['[computed]'], undefined);
});

test('every declared session-state owner is a real file path under src/daemon', () => {
  for (const [field, owners] of Object.entries(SESSION_STATE_FIELD_OWNERS)) {
    assert.ok(owners.length > 0, `${field} must name at least one owner`);
    for (const owner of owners) {
      assert.match(
        owner,
        /^src\/daemon\/.+\.ts$/,
        `${field} owner ${owner} must be a daemon module`,
      );
    }
    assert.deepEqual([...owners], [...owners].sort(), `${field} owners must be sorted`);
  }
});

// R8: the zero-dep CI job contract. These tests use synthetic workflows and a synthetic tree,
// because the point of the rule is to catch a shape that does not exist in the repo yet.

const ZERO_DEP_WORKFLOW = `
name: CI
jobs:
  installs-deps:
    steps:
      - uses: ./.github/actions/setup-node-pnpm
      - run: node scripts/needs-packages/entry.ts
  zero-dep:
    steps:
      - uses: ./.github/actions/setup-node-pnpm
        with:
          install-deps: false
      - run: |
          node --experimental-strip-types --test scripts/probe/entry.test.ts
          node --experimental-strip-types scripts/probe/entry.ts
`;

test('a zero-dep job is discovered from the workflow, and a dep-installing one is not', () => {
  const present = new Set(['scripts/probe/entry.ts', 'scripts/probe/entry.test.ts']);
  const jobs = zeroDepJobs(new Map([['.github/workflows/probe.yml', ZERO_DEP_WORKFLOW]]), (file) =>
    present.has(file),
  );
  assert.deepEqual(jobs, [
    {
      workflow: '.github/workflows/probe.yml',
      job: 'zero-dep',
      // Sorted, deduplicated, and filtered to paths that exist — `scripts/needs-packages`
      // belongs to the job that installs deps and must not leak in.
      entries: ['scripts/probe/entry.test.ts', 'scripts/probe/entry.ts'],
    },
  ]);
});

test('install-deps: false counts whether YAML parsed it as a boolean or a string', () => {
  const quoted = ZERO_DEP_WORKFLOW.replace('install-deps: false', "install-deps: 'false'");
  const jobs = zeroDepJobs(new Map([['w.yml', quoted]]), () => true);
  assert.deepEqual(
    jobs.map(({ job }) => job),
    ['zero-dep'],
  );
});

test('a job with no recognizable entry script is reported rather than exempted', () => {
  // Fail-closed: `entries: []` is what check.ts turns into a violation, so a job that
  // invokes its script in some way the scan cannot read never escapes the rule silently.
  const jobs = zeroDepJobs(new Map([['w.yml', ZERO_DEP_WORKFLOW]]), () => false);
  assert.deepEqual(jobs, [{ workflow: 'w.yml', job: 'zero-dep', entries: [] }]);
});

test('a package import anywhere in a zero-dep closure is rejected, builtins are not', () => {
  const tree = new Map([
    [
      'scripts/probe/entry.ts',
      "import fs from 'node:fs';\nimport path from 'path';\nimport { helper } from './helper.ts';\n",
    ],
    // One hop deeper than the entry: the failure that motivated R8 was exactly this shape —
    // the entry script itself imported nothing external, its helper did.
    ['scripts/probe/helper.ts', "import { parseSync } from 'oxc-parser';\nimport './deep.js';\n"],
    ['scripts/probe/deep.ts', "const lazy = await import('yaml');\n"],
  ]);
  const found = uninstallableImports(
    { workflow: 'w.yml', job: 'zero-dep', entries: ['scripts/probe/entry.ts'] },
    (file) => tree.get(file) ?? null,
    (file) => tree.has(file),
  );
  assert.deepEqual(
    found.map(({ file, spec }) => `${file}:${spec}`),
    // `node:fs` and bare `path` are builtins; `./helper.ts` and `./deep.js` resolve into the
    // tree (including the .js -> .ts rewrite); a dynamic package import fails just the same.
    ['scripts/probe/deep.ts:yaml', 'scripts/probe/helper.ts:oxc-parser'],
  );
});

test('an import written inside a string is not a package import', () => {
  // A zero-dep job runs test files, and a test about imports naturally embeds import syntax as
  // a fixture string. R8 parses instead of scanning lines precisely so those stay invisible —
  // this file itself contains such fixtures, and reported two phantom violations before the
  // switch. A type-only package import, by contrast, is still a resolve at runtime under
  // --experimental-strip-types only because the type is erased; it is listed to prove the
  // parser sees it, since erasure is a compiler detail and not something to lean on.
  const tree = new Map([
    [
      'scripts/probe/entry.ts',
      [
        'const fixture = "import real from \'not-a-package\'";',
        "const also = ['export { x } from \\'nope\\''];",
        "import type { T } from 'is-a-package';",
        'export type Alias = T;',
      ].join('\n'),
    ],
  ]);
  const found = uninstallableImports(
    { workflow: 'w.yml', job: 'zero-dep', entries: ['scripts/probe/entry.ts'] },
    (file) => tree.get(file) ?? null,
    (file) => tree.has(file),
  );
  assert.deepEqual(
    found.map(({ spec, line }) => `${line}:${spec}`),
    ['3:is-a-package'],
  );
});

test("the repo's own zero-dep jobs resolve without node_modules", () => {
  const repoRoot = path.resolve(import.meta.dirname, '../..');
  const read = (file: string): string | null => {
    const absolute = path.join(repoRoot, file);
    return existsSync(absolute) && statSync(absolute).isFile()
      ? readFileSync(absolute, 'utf8')
      : null;
  };
  const exists = (file: string): boolean => read(file) !== null;

  const jobs = zeroDepJobs(new Map([['.github/workflows/ci.yml', read('.github/workflows/ci.yml')!]]), exists);
  assert.ok(jobs.length > 0, 'expected ci.yml to still declare at least one zero-dep job');
  for (const job of jobs) {
    assert.ok(job.entries.length > 0, `${job.job} must name an entry script`);
    assert.deepEqual(uninstallableImports(job, read, exists), [], `${job.job} must reach no package`);
  }
});

test('a session write counts through an aliased binding, not only one named `session`', () => {
  // The daemon names these records by role: nextSession, provisionalSession, completedSession,
  // preRunSession, preEntrySession, activeSession. Matching only the literal name `session` hid
  // three real foreign writes — nextSession.snapshotGeneration in snapshot-runtime.ts among them
  // — while the gate reported that every write was inside its owner.
  const writes = findSessionStateWrites(
    new Map([
      [
        'src/daemon/probe.ts',
        [
          'nextSession.snapshotGeneration = 3;',
          'preEntrySession.refFrameState = "active";',
          'completedSession.saveScriptComplete = true;',
          // Not a session binding, and not a session write.
          'result.snapshotGeneration = 9;',
          'flags.refFrameState = "x";',
        ].join('\n'),
      ],
    ]),
    ['snapshotGeneration', 'refFrameState', 'saveScriptComplete'],
  );
  assert.deepEqual(
    writes.map(({ field, line }) => `${line}:${field}`),
    ['1:snapshotGeneration', '2:refFrameState', '3:saveScriptComplete'],
  );
});

test('every SessionState field is classified exactly once', () => {
  // Exhaustiveness is the point: without this, a new field with no direct write would satisfy
  // R7 by being invisible to the scan, and the rule would silently stop covering part of the
  // type it claims to cover.
  const fields = sessionStateFields(
    readFileSync(path.resolve(import.meta.dirname, '../../src/daemon/types.ts'), 'utf8'),
  );
  assert.deepEqual(fieldClassificationDrift(fields), []);
  assert.equal(
    Object.keys(SESSION_STATE_FIELD_OWNERS).length + STORE_OWNED_SESSION_STATE_FIELDS.size,
    fields.length,
  );
});

test('classification drift is reported in all three directions', () => {
  const declared = sessionStateFields(
    readFileSync(path.resolve(import.meta.dirname, '../../src/daemon/types.ts'), 'utf8'),
  );

  // Unclassified: a field added to SessionState and to neither table. This is the case the
  // reviewer's finding was about — before parity, such a field passed the gate unnoticed.
  assert.deepEqual(fieldClassificationDrift([...declared, 'brandNewField']), [
    { field: 'brandNewField', problem: 'unclassified' },
  ]);

  // Stale: a table names a field SessionState no longer declares. Dropping one declared field
  // makes exactly that name stale.
  assert.deepEqual(fieldClassificationDrift(declared.filter((field) => field !== 'trace')), [
    { field: 'trace', problem: 'not-a-field' },
  ]);

  // Contradictory: a field cannot be both store-established and owned by a writer. The real
  // tables must never overlap, which is what makes the `both` branch unreachable in practice.
  const inBoth = [...STORE_OWNED_SESSION_STATE_FIELDS].filter(
    (field) => field in SESSION_STATE_FIELD_OWNERS,
  );
  assert.deepEqual(inBoth, [], 'the real tables must not overlap');
});

// R9 shipped its first revision with no test — every other rule here has one, and the only
// verification was a manual injection CI cannot repeat. These pin the three distinctions the rule
// depends on: which edge kinds count, and that an acyclic graph reports 1 rather than 0.
test('largestTypeCycleSize counts type-only cycles and ignores dynamic ones', () => {
  // Acyclic: every component is a single file, so the largest is 1 (not 0).
  const acyclic = resolveImportEdges(
    new Map(Object.entries({
      'src/core/a.ts': "import type { B } from '../contracts/b.ts';",
      'src/contracts/b.ts': 'export type B = 1;',
    })),
  );
  assert.equal(largestTypeCycleSize(acyclic), 1);

  // A three-file loop closed by type-only imports is exactly what R4 permits and R9 measures.
  const typeCycle = resolveImportEdges(
    new Map(Object.entries({
      'src/core/a.ts': "import type { B } from './b.ts';",
      'src/core/b.ts': "import type { C } from './c.ts';\nexport type B = 1;",
      'src/core/c.ts': "import type { A } from './a.ts';\nexport type C = 1;",
    })),
  );
  assert.equal(largestTypeCycleSize(typeCycle), 3);

  // A loop closed through a DYNAMIC import is excluded on purpose: a lazy seam is not a
  // comprehension barrier, and R3 relies on dynamic imports existing. With no non-dynamic edge at
  // all no file enters the walk, so the floor here is 0 rather than 1 — specified, not incidental.
  const dynamicCycle = resolveImportEdges(
    new Map(Object.entries({
      'src/core/a.ts': "void import('./b.ts');",
      'src/core/b.ts': "void import('./a.ts');",
    })),
  );
  assert.equal(largestTypeCycleSize(dynamicCycle), 0);

  // A value cycle counts too — R4 rejects it separately, so R9 must not be the thing that
  // notices, but it must not under-report either.
  const valueCycle = resolveImportEdges(
    new Map(Object.entries({
      'src/core/a.ts': "export { b } from './b.ts';",
      'src/core/b.ts': "export { a } from './a.ts';",
    })),
  );
  assert.equal(largestTypeCycleSize(valueCycle), 2);
});
