import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import {
  MAESTRO_CONFORMANCE_FIXTURE_DIRECTORY,
  MAESTRO_CONFORMANCE_NORMALIZED_FIXTURE,
  checkConformance,
  regenerateConformance,
} from './maestro-conformance.ts';

test('checked-in Maestro 2.5.1 fixtures match the agent-device model', () => {
  const result = checkConformance();

  assert.equal(result.upstream.version, '2.5.1');
  assert.equal(result.upstream.commit, 'a4c7c95f5ba1884858f7e35efa6b8e0165db9448');
  assert.deepEqual(
    result.cases.map((entry) => entry.id),
    ['pager-percentage-swipe', 'launch-defaults', 'selectors', 'runflow-include-provenance'],
  );
});

test('normalization covers percentage swipes, launch defaults, selectors, and includes', () => {
  const result = checkConformance();
  const pager = result.cases.find((entry) => entry.id === 'pager-percentage-swipe');
  const launch = result.cases.find((entry) => entry.id === 'launch-defaults');
  const selectors = result.cases.find((entry) => entry.id === 'selectors');
  const include = result.cases.find((entry) => entry.id === 'runflow-include-provenance');

  assert.deepEqual(pager?.expected[0], {
    kind: 'swipe',
    mode: 'relative',
    start: [90, 50],
    end: [10, 50],
    durationMs: 400,
    source: { path: 'pager-percentage-swipe.yaml', line: 3 },
  });
  assert.deepEqual(launch?.expected[0], {
    kind: 'launchApp',
    appId: 'com.example.pager',
    stopApp: true,
    source: { path: 'launch-defaults.yaml', line: 3 },
  });
  assert.deepEqual(
    selectors?.expected.map((entry) => entry),
    [
      {
        kind: 'tapOn',
        selector: { text: 'Open details' },
        source: { path: 'selectors.yaml', line: 3 },
      },
      {
        kind: 'tapOn',
        selector: { id: 'pager-next', index: 1, childOf: { id: 'pager' } },
        source: { path: 'selectors.yaml', line: 4 },
      },
      {
        kind: 'tapOn',
        selector: { text: 'Ready', enabled: false },
        source: { path: 'selectors.yaml', line: 9 },
      },
    ],
  );
  assert.deepEqual(
    include?.expected.map((entry) => entry.source),
    [
      { path: 'runflow-main.yaml', line: 3 },
      { path: 'runflow-child.yaml', line: 3 },
      { path: 'runflow-child.yaml', line: 4 },
      { path: 'runflow-main.yaml', line: 6 },
    ],
  );
});

test('regeneration is explicit and produces a checkable normalized fixture', () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-conformance-'));
  try {
    fs.cpSync(MAESTRO_CONFORMANCE_FIXTURE_DIRECTORY, temporaryDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(temporaryDirectory, MAESTRO_CONFORMANCE_NORMALIZED_FIXTURE),
      '{"schemaVersion":1,"cases":[]}\n',
    );

    const regenerated = regenerateConformance({ fixtureDirectory: temporaryDirectory });
    assert.equal(regenerated.cases.length, 4);
    assert.doesNotThrow(() => checkConformance({ fixtureDirectory: temporaryDirectory }));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
