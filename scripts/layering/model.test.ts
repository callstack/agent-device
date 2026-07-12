import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import {
  RANKED_ZONES,
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
      ['src/utils/shared.ts', "import '../core/platform-plugin.ts';"],
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
  assert.equal(classifyZone('utils'), 'unranked');
  assert.equal(classifyZone('mcp'), 'unranked');
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
