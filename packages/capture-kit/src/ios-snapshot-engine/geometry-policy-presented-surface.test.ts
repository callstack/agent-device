import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from 'vitest';
import type { PresentedSurface, RawSnapshotNode } from '@agent-device/kernel/snapshot';
import {
  ALERT_ROOT_CLASS_PREFIX,
  PRESENTATION_CONTAINER_CLASS,
  PRESENTATION_DIMMING_VIEW_CLASS,
  PRESENTING_ELEMENT_TYPES,
  SYSTEM_WINDOW_CLASSES,
  collectPresentedSurface,
  type PresentedSurfaceCompleteness,
} from './geometry-policy.ts';

const FIXTURE_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'contracts',
  'fixtures',
  'ios-presented-surface.json',
);

type FixtureNode = {
  index: number;
  parentIndex?: number;
  type: string;
  role?: string;
  label?: string;
  userInteractionEnabled?: boolean;
};

type FixtureCase = {
  name: string;
  truncated: boolean | null;
  expected: PresentedSurface;
  classBlindExpected: PresentedSurface;
  nodes: FixtureNode[];
};

type Fixture = {
  vocabulary: {
    presentationContainerClass: string;
    dimmingViewClass: string;
    alertRootClassPrefix: string;
    systemWindowClasses: string[];
    presentingElementTypes: Array<{ name: string; elementType: number }>;
  };
  cases: FixtureCase[];
};

function readFixture(): Fixture {
  return JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as Fixture;
}

// The classifier must mirror the canonical table and the vocabulary it mirrors by hand. The Swift
// SnapshotPresentedSurface checks the same table's `classBlindExpected` column.
test('the classifier mirrors the canonical vocabulary exactly', () => {
  const vocabulary = readFixture().vocabulary;
  expect(vocabulary.presentationContainerClass).toBe(PRESENTATION_CONTAINER_CLASS);
  expect(vocabulary.dimmingViewClass).toBe(PRESENTATION_DIMMING_VIEW_CLASS);
  expect(vocabulary.alertRootClassPrefix).toBe(ALERT_ROOT_CLASS_PREFIX);
  expect(new Set(vocabulary.systemWindowClasses)).toEqual(SYSTEM_WINDOW_CLASSES);
  expect(Object.fromEntries(PRESENTING_ELEMENT_TYPES)).toEqual(
    Object.fromEntries(
      vocabulary.presentingElementTypes.map((entry) => [entry.name, entry.elementType]),
    ),
  );
});

// Every case runs twice: once with the UIKit class names the table spells, once with every class name
// stripped, which is what a capture from a producer that reports none — every XCTest runner tier —
// actually looks like. That reading is what `classBlindExpected` states, and it is why the table can
// hold a case a bridge capture answers `presented` and a runner capture answers `unknown`.
test('every golden case classifies as the table states', () => {
  for (const testCase of readFixture().cases) {
    const completeness = completenessOf(testCase);
    expect(collectPresentedSurface(nodesOf(testCase), completeness)).toBe(testCase.expected);
    expect(collectPresentedSurface(classBlindNodesOf(testCase), completeness)).toBe(
      testCase.classBlindExpected,
    );
  }
});

/**
 * The producer's own completeness claim, which the table states as `truncated`: a null is a producer
 * that observes nothing about truncation, and cannot be read as complete.
 */
function completenessOf(testCase: FixtureCase): PresentedSurfaceCompleteness {
  if (testCase.truncated === null) return 'unstated';
  return testCase.truncated ? 'capped' : 'complete';
}

function nodesOf(testCase: FixtureCase): RawSnapshotNode[] {
  return testCase.nodes.map((node) => ({ ...node }));
}

function classBlindNodesOf(testCase: FixtureCase): RawSnapshotNode[] {
  return testCase.nodes.map(({ role: _role, ...node }) => ({ ...node }));
}
