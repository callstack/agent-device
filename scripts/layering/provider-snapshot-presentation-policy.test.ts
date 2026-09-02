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
