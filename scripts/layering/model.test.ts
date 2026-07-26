import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import {
  findSessionStateWrites,
  sessionStateFields,
  SESSION_STATE_FIELD_OWNERS,
} from './session-state.ts';
import {
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
