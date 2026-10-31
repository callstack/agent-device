import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { listSourceFiles } from './check.ts';
import {
  collectBackEdges,
  RANKED_ZONES,
  resolveImportEdges,
  targetDagZone,
  zoneRank,
} from './model.ts';
import { rootModuleZoneDrift } from './root-module-zones.ts';

test('every root module is declared in exactly one zone, and every declaration names a module', () => {
  assert.deepEqual(
    rootModuleZoneDrift(listSourceFiles()),
    { undeclared: [], stale: [], duplicated: [] },
    'place a new module under its zone folder; each module still directly under src/ needs ' +
      'exactly one ROOT_MODULE_ZONES row (root-module-zones.ts)',
  );
});

test('drift names a root module with no declared zone and a declaration with no module', () => {
  const drift = rootModuleZoneDrift(['src/bin.ts', 'src/new-helper.ts', 'src/cli/new-helper.ts']);
  assert.deepEqual(drift.undeclared, ['src/new-helper.ts']);
  assert.ok(drift.stale.includes('src/daemon.ts'));
  assert.ok(!drift.stale.includes('src/bin.ts'));
});

test('(root) ranks above every other zone', () => {
  const root = zoneRank('(root)')!;
  for (const zone of RANKED_ZONES) {
    if (zone !== '(root)') assert.ok(zoneRank(zone)! < root, `${zone} must rank below (root)`);
  }
});

test('R5 ranks a root module by its declared zone, so no lower zone reaches the command runtime through it', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/cli/example.ts', "import { io } from '../io.ts';"],
      ['src/commands/example.ts', "import { io } from '../io.ts';"],
      ['packages/contracts/src/example.ts', "import { io } from '../../../src/io.ts';"],
      ['src/io.ts', 'export const io = 1;'],
    ]),
  );

  assert.ok(
    edges.some(
      (edge) => edge.file === 'packages/contracts/src/example.ts' && edge.target === 'src/io.ts',
    ),
  );

  // A root module ranks at its declared zone, not at `(root)`: the equal-rank and higher-rank
  // importers pass and only the contracts importer is a back-edge.
  assert.deepEqual(collectBackEdges(edges), {
    'contracts -> command-runtime': ['packages/contracts/src/example.ts -> src/io.ts'],
  });
});

test('every ranked zone but (root) reaches the operation host only through import()', () => {
  const host = 'src/platform-runtime-operation-host.ts';
  const lazyImporter = 'src/platform-runtime.ts';
  const files = listSourceFiles().sort();
  // One real file per ranked zone, so a zone added to the spine is covered too.
  const importerByZone = new Map<string, string>();
  for (const zone of RANKED_ZONES) {
    if (zone === '(root)' || zone === targetDagZone(host)) continue;
    const importer = files.find((file) => file !== lazyImporter && targetDagZone(file) === zone);
    assert.ok(importer, `no production file in ${zone} to import the host from`);
    importerByZone.set(zone, importer);
  }
  const staticImport = (file: string) => {
    const specifier = path.posix.relative(path.posix.dirname(file), host);
    return `import '${specifier.startsWith('.') ? specifier : `./${specifier}`}';`;
  };
  const edges = resolveImportEdges(
    new Map([
      [lazyImporter, "void import('./platform-runtime-operation-host.ts');"],
      [host, ''],
      ...[...importerByZone.values()].map((file) => [file, staticImport(file)] as const),
    ]),
  );

  assert.deepEqual(
    collectBackEdges(edges),
    Object.fromEntries(
      [...importerByZone].map(([zone, file]) => [
        `${zone} -> platform-runtime-host`,
        [`${file} -> ${host}`],
      ]),
    ),
  );
});

test('an undeclared root module is (root), so a ranked import of it is a back-edge', () => {
  const edges = resolveImportEdges(
    new Map([
      ['src/commands/surface.ts', "import { shared } from '../new-helper.ts';"],
      ['src/new-helper.ts', 'export const shared = 1;'],
    ]),
  );

  assert.deepEqual(collectBackEdges(edges), {
    'commands -> (root)': ['src/commands/surface.ts -> src/new-helper.ts'],
  });
});
