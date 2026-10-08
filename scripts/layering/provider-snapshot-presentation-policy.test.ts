import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  IOS_SNAPSHOT_PRESENTATION_OWNER,
  PROVIDER_SNAPSHOT_PRESENTATION_RULE,
  providerSnapshotPresentationViolations,
} from './provider-snapshot-presentation-policy.ts';
import { resolveImportEdges } from './model.ts';
import { workspaceSpecifierTargets } from './package-boundaries.ts';
import { listTrackedProductionSources } from './tracked-sources.ts';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const providerHelper = 'packages/provider-webdriver/src/provider-snapshot-helper.ts';

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
  return providerSnapshotPresentationViolations(
    sources,
    resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot)),
  );
}

test('provider packages use the acquisition entrypoint and cannot reach presentation', () => {
  assert.deepEqual(violations(), []);
});

test('R73 rejects an out-of-adapter provider presentation import', () => {
  const result = violations(
    new Map([
      [
        providerHelper,
        `import { presentIosSnapshot } from '@agent-device/capture-kit/ios-snapshot-engine';\nvoid presentIosSnapshot;\n`,
      ],
    ]),
  );
  assert.ok(
    result.some(
      (entry) =>
        entry.rule === PROVIDER_SNAPSHOT_PRESENTATION_RULE &&
        entry.file === providerHelper &&
        entry.message.includes(IOS_SNAPSHOT_PRESENTATION_OWNER),
    ),
    JSON.stringify(result),
  );
});

test('R73 rejects a provider import of the capture-kit presentation runtime subpath', () => {
  const result = violations(
    new Map([
      [
        providerHelper,
        `import { presentIosSnapshot } from '@agent-device/capture-kit/ios-snapshot-runtime';\nvoid presentIosSnapshot;\n`,
      ],
    ]),
  );
  assert.ok(
    result.some(
      (entry) =>
        entry.rule === PROVIDER_SNAPSHOT_PRESENTATION_RULE &&
        entry.file === providerHelper &&
        entry.message.includes(IOS_SNAPSHOT_PRESENTATION_OWNER),
    ),
    JSON.stringify(result),
  );
});

test('R73 preserves breadth-first origin and finding order through a shared import graph', () => {
  const provider = 'packages/provider-webdriver/src/provider.ts';
  const first = 'src/graph-first.ts';
  const second = 'src/graph-second.ts';
  const join = 'src/graph-join.ts';
  const firstPresentation = 'packages/capture-kit/src/snapshot/first.ts';
  const secondPresentation = 'packages/capture-kit/src/snapshot/second.ts';
  const joinedPresentation = 'packages/capture-kit/src/snapshot/joined.ts';
  const sources = new Map([
    [provider, "import '../../../src/graph-first.ts';\nimport '../../../src/graph-second.ts';\n"],
    [first, "import '../packages/capture-kit/src/snapshot/first.ts';\nimport './graph-join.ts';\n"],
    [
      second,
      "import '../packages/capture-kit/src/snapshot/second.ts';\nimport './graph-join.ts';\n",
    ],
    [join, "import '../packages/capture-kit/src/snapshot/joined.ts';\n"],
    [firstPresentation, 'export const first = true;\n'],
    [secondPresentation, 'export const second = true;\n'],
    [joinedPresentation, 'export const joined = true;\n'],
  ]);
  const result = providerSnapshotPresentationViolations(
    sources,
    resolveImportEdges(sources, workspaceSpecifierTargets(repoRoot)),
  );

  assert.deepEqual(
    result.map(({ line, message }) => ({
      line,
      target: /reaches (.+?) before/.exec(message)?.[1],
    })),
    [
      { line: 1, target: firstPresentation },
      { line: 2, target: secondPresentation },
      { line: 1, target: joinedPresentation },
    ],
  );
});

for (const planted of [
  {
    name: 'a planted provider residue discard',
    source: 'export const discarded = { residue: [] };\n',
    message: 'construct or discard acquisition residue',
  },
  {
    name: 'a planted provider residue rewrite',
    source: 'export function rewrite(carrier) { carrier.acquisition.residue = []; }\n',
    message: 'rewrite acquisition residue',
  },
]) {
  test(`R73 rejects ${planted.name}`, () => {
    const result = violations(new Map([[providerHelper, planted.source]]));
    assert.ok(
      result.some(
        (entry) =>
          entry.rule === PROVIDER_SNAPSHOT_PRESENTATION_RULE &&
          entry.file === providerHelper &&
          entry.message.includes(planted.message),
      ),
      JSON.stringify(result),
    );
  });
}
