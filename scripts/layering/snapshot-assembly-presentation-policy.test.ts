import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  SNAPSHOT_ASSEMBLY_FILES,
  SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
  snapshotAssemblyPresentationViolations,
} from './snapshot-assembly-presentation-policy.ts';
import { resolveImportEdges } from './model.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { listTrackedProductionSources } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const assemblyFile = 'packages/capture-kit/src/snapshot-state.ts';
const producerAdapter = 'packages/platform-apple/src/snapshot-source/adapter.ts';

function currentSources(overrides: ReadonlyMap<string, string> = new Map()): Map<string, string> {
  const sources = new Map(
    listTrackedProductionSources(repoRoot).map((file) => [
      file,
      fs.readFileSync(path.join(repoRoot, file), 'utf8'),
    ]),
  );
  for (const [file, source] of overrides) sources.set(file, source);
  return sources;
}

function violations(overrides: ReadonlyMap<string, string> = new Map()) {
  const sources = currentSources(overrides);
  return snapshotAssemblyPresentationViolations(
    sources,
    resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot)),
  );
}

function appended(file: string, addition: string): ReadonlyMap<string, string> {
  return new Map([[file, `${fs.readFileSync(path.join(repoRoot, file), 'utf8')}${addition}`]]);
}

test('the snapshot assembly and the producer adapters are presentation-neutral', () => {
  assert.deepEqual(violations(), []);
});

test('R74 rejects the assembly importing the iOS snapshot engine', () => {
  const result = violations(
    appended(
      assemblyFile,
      `\nimport { buildIosInteractiveSnapshotPresentation } from '@agent-device/capture-kit/ios-snapshot-engine';\nvoid buildIosInteractiveSnapshotPresentation;\n`,
    ),
  );

  assert.ok(
    result.some(
      (entry) =>
        entry.rule === SNAPSHOT_ASSEMBLY_PRESENTATION_RULE &&
        entry.file === assemblyFile &&
        entry.message.includes('must not import iOS presentation'),
    ),
    JSON.stringify(result),
  );
});

test('R74 rejects the assembly importing the iOS acquisition module', () => {
  const result = violations(
    appended(
      assemblyFile,
      `\nimport { createIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-acquisition';\nvoid createIosSnapshotAcquisition;\n`,
    ),
  );

  assert.ok(
    result.some(
      (entry) =>
        entry.rule === SNAPSHOT_ASSEMBLY_PRESENTATION_RULE &&
        entry.file === assemblyFile &&
        entry.message.includes('ios-snapshot-acquisition'),
    ),
    JSON.stringify(result),
  );
});

test('R74 rejects the assembly reading the producer registry', () => {
  const result = violations(
    appended(
      assemblyFile,
      `\nimport { SNAPSHOT_PRODUCERS as registry } from '@agent-device/contracts/snapshot-model';\nvoid registry;\n`,
    ),
  );

  assert.ok(
    result.some(
      (entry) =>
        entry.rule === SNAPSHOT_ASSEMBLY_PRESENTATION_RULE &&
        entry.file === assemblyFile &&
        entry.message.includes('SNAPSHOT_PRODUCERS'),
    ),
    JSON.stringify(result),
  );
});

const producerRows = 'packages/capture-kit/src/producer-rows.ts';

/** Registry reads that do not spell a registry name where the assembly uses it. */
const REGISTRY_READ_FORMS: readonly (readonly [string, string, string?])[] = [
  [
    'a computed string member of a facade namespace',
    `import * as contracts from '@agent-device/contracts/snapshot';\nvoid contracts['snapshotProducerFacts'];`,
  ],
  [
    'a dotted member of a registry-module namespace',
    `import * as model from '@agent-device/contracts/snapshot-model';\nvoid model.SNAPSHOT_PRODUCERS;`,
  ],
  [
    'a template-literal member of a namespace',
    "import * as model from '@agent-device/contracts/snapshot-model';\nvoid model[`SNAPSHOT_PRODUCERS`];",
  ],
  [
    'a member of a default import',
    `import model from '@agent-device/contracts/snapshot-model';\nvoid model.snapshotProducerFacts;`,
  ],
  [
    'a namespace member read by a computed key',
    `import * as contracts from '@agent-device/contracts/snapshot';\nconst key = 'SNAPSHOT_PRODUCERS' as const;\nvoid contracts[key];`,
  ],
  [
    'a destructured namespace',
    `import * as contracts from '@agent-device/contracts/snapshot';\nconst { snapshotProducerFacts: facts } = contracts;\nvoid facts;`,
  ],
  [
    'a namespace passed on whole',
    `import * as contracts from '@agent-device/contracts/snapshot';\nexport const surface = contracts;`,
  ],
  [
    'an aliased re-export through another module',
    `import { rows } from './producer-rows.ts';\nvoid rows;`,
    `export { SNAPSHOT_PRODUCERS as rows } from '@agent-device/contracts/snapshot';\n`,
  ],
  [
    'a namespace re-export through another module',
    `import { registry } from './producer-rows.ts';\nvoid registry['snapshotProducerFacts'];`,
    `export * as registry from '@agent-device/contracts/snapshot-model';\n`,
  ],
  [
    'a star re-export through another module',
    `import { snapshotProducerFacts as lookup } from './producer-rows.ts';\nvoid lookup;`,
    `export * from '@agent-device/contracts/snapshot-model';\n`,
  ],
  [
    'an import then local re-export through another module',
    `import { table } from './producer-rows.ts';\nvoid table;`,
    `import { SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot';\nexport { SNAPSHOT_PRODUCERS as table };\n`,
  ],
  [
    'a re-export from the assembly itself',
    `export { SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot';`,
  ],
  [
    'a dynamic import of the registry module',
    `export const rows = async () => (await import('@agent-device/contracts/snapshot-model')).SNAPSHOT_PRODUCERS;`,
  ],
];

for (const [form, addition, rowsModule] of REGISTRY_READ_FORMS) {
  test(`R74 rejects the assembly reading the producer registry through ${form}`, () => {
    const overrides = new Map(appended(assemblyFile, `\n${addition}\n`));
    if (rowsModule !== undefined) overrides.set(producerRows, rowsModule);
    const result = violations(overrides).filter(
      (entry) =>
        entry.rule === SNAPSHOT_ASSEMBLY_PRESENTATION_RULE &&
        entry.file === assemblyFile &&
        entry.message.includes('must not read the producer registry'),
    );

    assert.notDeepEqual(result, [], form);
  });
}

test('R74 accepts a namespace of the registry module that reads only non-registry members', () => {
  const result = violations(
    appended(
      assemblyFile,
      `\nimport * as contracts from '@agent-device/contracts/snapshot';\nvoid contracts.snapshotRefMinting;\nvoid contracts['isSnapshotBackend'];\nconst { snapshotStateProvenance: provenance } = contracts;\nvoid provenance;\nexport type Producer = contracts.SnapshotProducer;\n`,
    ),
  );

  assert.deepEqual(result, []);
});

test('R74 rejects a backend-name presentation branch in the assembly', () => {
  const result = violations(
    appended(
      assemblyFile,
      `\nexport function presentsHere(backend: string): boolean {\n  return backend === 'xctest';\n}\n`,
    ),
  );

  assert.ok(
    result.some(
      (entry) =>
        entry.rule === SNAPSHOT_ASSEMBLY_PRESENTATION_RULE &&
        entry.file === assemblyFile &&
        entry.message.includes("('xctest')"),
    ),
    JSON.stringify(result),
  );
});

test('R74 rejects an assembly branch on a producer name', () => {
  const result = violations(
    appended(assemblyFile, `\nexport const legacyOwner = 'simulator-ax-bridge';\n`),
  );

  assert.ok(
    result.some(
      (entry) =>
        entry.rule === SNAPSHOT_ASSEMBLY_PRESENTATION_RULE &&
        entry.file === assemblyFile &&
        entry.message.includes("('simulator-ax-bridge')"),
    ),
    JSON.stringify(result),
  );
});

test('R74 rejects a producer adapter importing iOS presentation', () => {
  const result = violations(
    appended(
      producerAdapter,
      `\nimport { presentIosSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';\nvoid presentIosSnapshot;\n`,
    ),
  );

  assert.ok(
    result.some(
      (entry) =>
        entry.rule === SNAPSHOT_ASSEMBLY_PRESENTATION_RULE &&
        entry.file === producerAdapter &&
        entry.message.includes('producers report acquisition facts'),
    ),
    JSON.stringify(result),
  );
});

test('R74 fails closed when the assembly moves out from under it', () => {
  const sources = currentSources();
  for (const file of SNAPSHOT_ASSEMBLY_FILES) sources.delete(file);

  const result = snapshotAssemblyPresentationViolations(
    sources,
    resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot)),
  );

  assert.deepEqual(
    result.filter((entry) => entry.message.includes('is missing')).map((entry) => entry.file),
    [...SNAPSHOT_ASSEMBLY_FILES],
  );
});
