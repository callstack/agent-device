import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
import {
  largestTypeCycleMembers,
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

test('parseImports detects multiline dynamic imports', () => {
  const edges = parseImports(['void import(', "  '../multiline.ts'", ');'].join('\n'));

  assert.deepEqual(edges, [
    { spec: '../multiline.ts', dynamic: true, typeOnly: false, line: 1, symbols: [] },
  ]);
});

test('parseImports resolves constant-template dynamic imports', () => {
  const edges = parseImports('void import(`../template.ts`);');

  assert.deepEqual(edges, [
    { spec: '../template.ts', dynamic: true, typeOnly: false, line: 1, symbols: [] },
  ]);
});

test('parseImports retains named source symbols without changing edge-kind detection', () => {
  const edges = parseImports(
    [
      "import { value as localValue, type TypeA } from './named.ts';",
      "import type { TypeB as RenamedType } from './types.ts';",
      "export { reExport as publicName } from './re-export.ts';",
      "export type { ExportedType } from './exported-types.ts';",
      "import * as namespace from './namespace.ts';",
      "void import('./dynamic.ts');",
    ].join('\n'),
  );

  assert.deepEqual(
    edges.map(({ spec, dynamic, typeOnly, symbols }) => ({ spec, dynamic, typeOnly, symbols })),
    [
      {
        spec: './named.ts',
        dynamic: false,
        typeOnly: false,
        symbols: ['value', 'TypeA'],
      },
      { spec: './types.ts', dynamic: false, typeOnly: true, symbols: ['TypeB'] },
      { spec: './re-export.ts', dynamic: false, typeOnly: false, symbols: ['reExport'] },
      { spec: './exported-types.ts', dynamic: false, typeOnly: true, symbols: ['ExportedType'] },
      { spec: './namespace.ts', dynamic: false, typeOnly: false, symbols: [] },
      { spec: './dynamic.ts', dynamic: true, typeOnly: false, symbols: [] },
    ],
  );
});

test('parseImports ignores comments inside named bindings', () => {
  const edges = parseImports(
    [
      "import { /* exact, declared */ SessionStore /* authority */ } from './store.ts';",
      'import /* shape */ {',
      '  // exact declaration',
      '  type SessionState as State,',
      "} from './types.ts';",
    ].join('\n'),
  );

  assert.deepEqual(
    edges.map(({ spec, typeOnly, symbols }) => ({ spec, typeOnly, symbols })),
    [
      { spec: './store.ts', typeOnly: false, symbols: ['SessionStore'] },
      { spec: './types.ts', typeOnly: true, symbols: ['SessionState'] },
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
      ['src/contracts/result.ts', "import '../core/platform-plugin.ts';"],
      ['src/core/platform-plugin.ts', 'export const plugin = true;'],
      ['src/commands/help.ts', "import '../cli/parser.ts';"],
      ['src/cli/parser.ts', 'export const parser = true;'],
      ['src/(root-fixture)/shared.ts', "import './core/platform-plugin.ts';"],
    ]),
  );
  const actual = collectBackEdges(edges);
  assert.deepEqual(actual, {
    'commands -> cli': ['src/commands/help.ts -> src/cli/parser.ts'],
    'contracts -> core': ['src/contracts/result.ts -> src/core/platform-plugin.ts'],
  });
});

test('neutral ownership zones reject value imports into higher layers', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/contracts/result.ts', "import '../core/result.ts';"],
      ['src/core/result.ts', 'export const result = true;'],
      ['src/request/cancel.ts', "import '../commands/cancel.ts';"],
      ['src/commands/cancel.ts', 'export const cancel = true;'],
      ['packages/selectors/src/internal/parse.ts', "import '../../../../src/client/client.ts';"],
      ['src/client/client.ts', 'export const client = true;'],
      ['src/cli-schema/schema.ts', "import '../cli/parser.ts';"],
      ['src/cli/parser.ts', 'export const parser = true;'],
    ]),
  );

  assert.deepEqual(collectBackEdges(edges), {
    'cli-schema -> cli': ['src/cli-schema/schema.ts -> src/cli/parser.ts'],
    'contracts -> core': ['src/contracts/result.ts -> src/core/result.ts'],
    'request -> commands': ['src/request/cancel.ts -> src/commands/cancel.ts'],
    'selectors -> client': ['packages/selectors/src/internal/parse.ts -> src/client/client.ts'],
  });
});

test('a relative import resolves within its own workspace package src/, but not past it', () => {
  const edges = resolveImportEdges(
    new Map([
      ['packages/contracts/src/facades/device.ts', "import '../device.ts';"],
      ['packages/contracts/src/device.ts', 'export const device = true;'],
      // A value cycle closed entirely inside one package must be as visible to R4 as
      // one closed inside src/ — this is what #1781 A9-2 found invisible: `resolved`
      // landed under `packages/<name>/src/`, so the old `resolved.startsWith('src/')`
      // check dropped both edges and the reverse-reachability graph stopped at the
      // package facade.
      ['packages/contracts/src/cycle-a.ts', "import '../src/cycle-b.ts';"],
      ['packages/contracts/src/cycle-b.ts', "import '../src/cycle-a.ts';"],
      // A relative path that climbs out of any package's src/ (landing under a bare
      // `packages/<name>/` with no `src/` segment) must still be refused by the
      // model — R11 owns rejecting that import outright, but the graph itself must
      // not silently resolve a target outside src/ and packages/*/src/.
      ['packages/contracts/src/escape.ts', "import '../../outside-src.ts';"],
      ['packages/outside-src.ts', 'export const outsideSrc = true;'],
    ]),
  );

  assert.deepEqual(edges.map(({ file, target }) => `${file} -> ${target}`).sort(), [
    'packages/contracts/src/cycle-a.ts -> packages/contracts/src/cycle-b.ts',
    'packages/contracts/src/cycle-b.ts -> packages/contracts/src/cycle-a.ts',
    'packages/contracts/src/facades/device.ts -> packages/contracts/src/device.ts',
  ]);
  assert.deepEqual(findValueImportCycles(edges), [
    [
      'packages/contracts/src/cycle-a.ts',
      'packages/contracts/src/cycle-b.ts',
      'packages/contracts/src/cycle-a.ts',
    ],
  ]);
});

test('type-only edges are ranked by R6 and ignored by R5, and vice versa', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/commands/surface.ts', "import type { Shape } from '../client/client-types.ts';"],
      ['src/client/client-types.ts', 'export type Shape = { a: 1 };'],
      ['src/contracts/value.ts', "import '../core/logic.ts';"],
      ['src/core/logic.ts', 'export const logic = true;'],
      ['src/contracts/lazy.ts', "void import('../commands/surface.ts');"],
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
  assert.equal(classifyZone('contracts'), 'ranked');
  assert.equal(classifyZone('daemon-server'), 'ranked');
  assert.equal(classifyZone('(root)'), 'unranked');
  assert.equal(classifyZone('platform-runtime'), 'unranked');
  assert.equal(classifyZone('platforms'), 'unclassified');
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
  const productionFiles = listSourceFiles();
  assert.deepEqual(unclassifiedZones(productionFiles), []);

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
      ['src/daemon/handlers/session-audio.ts', 'session.somethingElse = 1;'],
      // reads and comparisons are not writes
      ['src/daemon/handlers/find.ts', "if (session.refFrameState === 'active') return;"],
      // a write into a sub-object is not a write to the field itself
      ['src/daemon/handlers/session-probe.ts', 'session.refFrameState.inner = 1;'],
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
    new Map(
      Object.entries({
        'src/core/a.ts': "import type { B } from '@agent-device/contracts/b';",
        'src/contracts/b.ts': 'export type B = 1;',
      }),
    ),
  );
  assert.equal(largestTypeCycleSize(acyclic), 1);

  // A three-file loop closed by type-only imports is exactly what R4 permits and R9 measures.
  const typeCycle = resolveImportEdges(
    new Map(
      Object.entries({
        'src/core/a.ts': "import type { B } from './b.ts';",
        'src/core/b.ts': "import type { C } from './c.ts';\nexport type B = 1;",
        'src/core/c.ts': "import type { A } from './a.ts';\nexport type C = 1;",
      }),
    ),
  );
  assert.equal(largestTypeCycleSize(typeCycle), 3);
  assert.deepEqual(largestTypeCycleMembers(typeCycle), [
    'src/core/a.ts',
    'src/core/b.ts',
    'src/core/c.ts',
  ]);

  // A loop closed through a DYNAMIC import is excluded on purpose: a lazy seam is not a
  // comprehension barrier. With no non-dynamic edge at
  // all no file enters the walk, so the floor here is 0 rather than 1 — specified, not incidental.
  const dynamicCycle = resolveImportEdges(
    new Map(
      Object.entries({
        'src/core/a.ts': "void import('./b.ts');",
        'src/core/b.ts': "void import('./a.ts');",
      }),
    ),
  );
  assert.equal(largestTypeCycleSize(dynamicCycle), 0);
  assert.deepEqual(largestTypeCycleMembers(dynamicCycle), []);

  // A value cycle counts too — R4 rejects it separately, so R9 must not be the thing that
  // notices, but it must not under-report either.
  const valueCycle = resolveImportEdges(
    new Map(
      Object.entries({
        'src/core/a.ts': "export { b } from './b.ts';",
        'src/core/b.ts': "export { a } from './a.ts';",
      }),
    ),
  );
  assert.equal(largestTypeCycleSize(valueCycle), 2);
});
