import fs from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'vitest';
import type { CaptureHint, IosSnapshotRequestInput } from '@agent-device/contracts/ios-snapshot';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import { IosSnapshotEngineError, presentIosSnapshot, publishIosSnapshot } from './index.ts';
import { runTypeScriptCase, writeDifferentialFailureArtifact } from './conformance-harness.ts';
import {
  acquisitionForGoldenCase,
  normalizeGoldenNodes,
  readIosSnapshotEngineFixture,
  requestForGoldenCase,
} from './conformance-fixture.ts';

const CAPTURE_HINT_FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'ios-snapshot-capture-hint.json',
);

type CaptureHintFixture = Readonly<{
  name: string;
  request: IosSnapshotRequestInput;
  expected: CaptureHint;
}>;

test('the independent capture-hint corpus agrees with the engine request boundary', () => {
  const fixtures = JSON.parse(
    fs.readFileSync(CAPTURE_HINT_FIXTURE_PATH, 'utf8'),
  ) as CaptureHintFixture[];
  assert.ok(fixtures.length > 0);
  assert.equal(new Set(fixtures.map((fixture) => fixture.name)).size, fixtures.length);
  for (const fixture of fixtures) {
    const request = createIosSnapshotRequest(fixture.request);
    assert.deepEqual(deriveIosCaptureHint(request), fixture.expected, fixture.name);
  }
});

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

test('differential failure artifacts preserve replay metadata', () => {
  const fixture = readIosSnapshotEngineFixture();
  const source = fixture.cases[0]!;
  const testCase = {
    name: source.name,
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
