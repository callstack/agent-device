import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import { IosSnapshotEngineError, presentIosSnapshot, publishIosSnapshot } from './index.ts';
import {
  canonicalNodes,
  runTypeScriptCase,
  runnerPresentationAgrees,
  writeDifferentialFailureArtifact,
} from './conformance-harness.ts';
import {
  acquisitionForGoldenCase,
  normalizeGoldenNodes,
  readIosSnapshotEngineFixture,
  requestForGoldenCase,
} from './conformance-fixture.ts';

function runnerCase(name: string) {
  const fixture = readIosSnapshotEngineFixture();
  const source = fixture.cases.find((testCase) => testCase.name === name);
  assert.ok(source);
  return { ...source, route: 'runner-presented' as const, viewport: fixture.viewport };
}

test('the authored iOS snapshot corpus covers each contract seam', () => {
  const fixture = readIosSnapshotEngineFixture();
  assert.equal(fixture.version, 1);
  assert.ok(fixture.cases.length >= 12);
  assert.equal(new Set(fixture.cases.map((testCase) => testCase.name)).size, fixture.cases.length);

  const required = [
    'nested ancestor clips and actionability',
    'viewport edge remains positively actionable',
    'geometryless cursor nodes keep independent descendants',
    'plain viewport keeps child visibility independent',
    'raw projection preserves reported geometry',
    'scope reroots wrappers and regular depth',
    'scope depth zero retains only the matched root',
    'raw scope depth counts source depth',
    'hidden scroll content becomes directional hints',
    'interactive only compacts semantic representatives',
    'unavailable hittability fails closed',
    'malformed parent is a typed failure',
    'missing viewport is a typed failure',
    'invalid viewport is a typed failure',
    'residue and truncation survive publication',
  ];
  for (const name of required) {
    assert.ok(
      fixture.cases.some((testCase) => testCase.name === name),
      name,
    );
  }
});

test('the independent iOS snapshot goldens match the TypeScript engine', () => {
  const fixture = readIosSnapshotEngineFixture();
  for (const testCase of fixture.cases) {
    const request = requestForGoldenCase(testCase);
    const acquisition = acquisitionForGoldenCase(fixture, testCase);
    const expected = testCase.expected;
    let actual:
      | {
          outcome: 'success';
          nodes: ReturnType<typeof normalizeGoldenNodes>;
          truncated?: boolean;
          residue: typeof acquisition.residue;
          qualityLabels?: readonly (string | null)[];
        }
      | {
          outcome: 'failure';
          nodes: [];
          error: { code: string; reason: string };
        };

    try {
      const presentation = presentIosSnapshot({ stage: 'acquired', acquisition }, request, {
        foldPolicy: testCase.foldPolicy,
      });
      const publication = publishIosSnapshot({ stage: 'acquired', acquisition }, request, {
        foldPolicy: testCase.foldPolicy,
      });
      actual = {
        outcome: 'success',
        nodes: normalizeGoldenNodes(publication.payload.nodes),
        ...(publication.payload.truncated === undefined
          ? {}
          : { truncated: publication.payload.truncated }),
        residue: publication.residue,
        ...(testCase.qualityLabels
          ? { qualityLabels: presentation.qualityNodes?.map((node) => node.label ?? null) }
          : {}),
      };
    } catch (error) {
      assert.ok(error instanceof IosSnapshotEngineError, testCase.name);
      actual = {
        outcome: 'failure',
        nodes: [],
        error: { code: error.code, reason: error.reason },
      };
    }
    assert.deepEqual(
      actual,
      testCase.qualityLabels ? { ...expected, qualityLabels: testCase.qualityLabels } : expected,
      testCase.name,
    );
  }
});

test('published payload omits unknown truncation instead of defaulting it', () => {
  const fixture = readIosSnapshotEngineFixture();
  const testCase = fixture.cases[0]!;
  const request = requestForGoldenCase(testCase);
  const acquisition = {
    ...acquisitionForGoldenCase(fixture, testCase),
    truncated: undefined,
  };

  const publication = publishIosSnapshot({ stage: 'acquired', acquisition }, request);

  assert.equal(publication.payload.truncated, undefined);
  assert.equal('truncated' in publication.payload, false);
});

test('the differential TypeScript runner preserves typed failures', () => {
  const fixture = readIosSnapshotEngineFixture();
  const source = fixture.cases.find(
    (testCase) => testCase.name === 'malformed parent is a typed failure',
  );
  assert.ok(source);
  const result = runTypeScriptCase({
    name: source.name,
    route: 'acquired',
    projection: source.projection,
    interactiveOnly: false,
    depth: source.depth,
    scope: source.scope,
    foldPolicy: source.foldPolicy,
    viewport: fixture.viewport,
    nodes: source.nodes,
  });
  assert.equal(result.outcome, 'failure');
  assert.ok(result.error?.code);
});

test('runner comparison accepts semantic delegation and rejects lost source membership', () => {
  const source = runnerCase('interactive only compacts semantic representatives');
  const testCase = {
    ...source,
    requiredLabels: ['General'],
    absentLabels: ['Missing'],
    clippedLabel: { label: 'General', rect: { x: 16, y: 80, width: 288, height: 52 } },
  };
  const acquired = runTypeScriptCase(testCase);
  const swift = (nodes: typeof source.nodes) => ({
    outcome: 'success' as const,
    nodes: canonicalNodes(nodes),
    rawNodes: nodes,
  });

  assert.equal(runnerPresentationAgrees(testCase, swift(source.nodes), acquired), true);
  assert.equal(
    runnerPresentationAgrees(testCase, swift(source.nodes.slice(0, 3)), acquired),
    true,
    'Swift may delegate Button and StaticText to the Cell representative',
  );
  assert.equal(
    runnerPresentationAgrees(testCase, swift(source.nodes.slice(0, 2)), acquired),
    false,
    'losing the Cell leaves General without a presented representative',
  );
});

test('runner comparison preserves typed failure reasons', () => {
  const testCase = runnerCase('malformed parent is a typed failure');
  const acquired = runTypeScriptCase(testCase);
  assert.equal(acquired.outcome, 'failure');
  assert.ok(acquired.error);

  assert.equal(
    runnerPresentationAgrees(
      testCase,
      { outcome: 'failure', nodes: [], error: acquired.error },
      acquired,
    ),
    true,
  );
  assert.equal(
    runnerPresentationAgrees(
      testCase,
      { outcome: 'failure', nodes: [], error: { ...acquired.error, reason: 'missing-viewport' } },
      acquired,
    ),
    false,
  );
  assert.equal(
    runnerPresentationAgrees(testCase, { outcome: 'success', nodes: [] }, acquired),
    false,
  );
});

test('runner comparison checks unscoped quality alongside scoped publication', () => {
  const testCase = runnerCase('scope reroots wrappers and regular depth');
  const acquired = runTypeScriptCase(testCase);
  assert.equal(acquired.outcome, 'success');
  const scoped = testCase.nodes.slice(2).map((node, index) => ({
    ...node,
    index,
    depth: index,
    ...(index === 0 ? { parentIndex: undefined } : { parentIndex: 0 }),
  }));
  const swift = {
    outcome: 'success' as const,
    nodes: canonicalNodes(scoped),
    rawNodes: scoped,
    qualityNodes: testCase.nodes,
  };

  assert.equal(runnerPresentationAgrees(testCase, swift, acquired), true);
  assert.equal(
    runnerPresentationAgrees(testCase, { ...swift, qualityNodes: scoped }, acquired),
    false,
    'a scoped quality payload must not lose the unscoped App and Wrapper',
  );
});

test('differential failure artifacts preserve replay metadata', () => {
  const fixture = readIosSnapshotEngineFixture();
  const source = fixture.cases[0]!;
  const testCase = {
    name: source.name,
    route: 'acquired' as const,
    projection: source.projection,
    interactiveOnly: false as const,
    depth: source.depth,
    scope: source.scope,
    foldPolicy: source.foldPolicy,
    viewport: fixture.viewport,
    nodes: source.nodes,
  };
  const artifact = writeDifferentialFailureArtifact({
    testCase,
    seed: 219101,
    counterexamplePath: '0:0',
  });
  const stored = JSON.parse(fs.readFileSync(artifact.casePath, 'utf8')) as {
    cases: readonly unknown[];
  };
  const metadata = fs.readFileSync(path.join(artifact.directory, 'replay-command.txt'), 'utf8');
  assert.equal(stored.cases.length, 1);
  assert.match(metadata, /seed=219101/);
  assert.match(metadata, /path=0:0/);
});
