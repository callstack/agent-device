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
      `\nimport { presentIosInteractiveSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';\nvoid presentIosInteractiveSnapshot;\n`,
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

test('R74 rejects the assembly reading the producer capability table', () => {
  const result = violations(
    appended(
      assemblyFile,
      `\nimport { iosSnapshotTruncationEvidence } from '@agent-device/capture-kit/ios-snapshot-acquisition';\nvoid iosSnapshotTruncationEvidence;\n`,
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
