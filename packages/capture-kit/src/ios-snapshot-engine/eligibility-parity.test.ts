import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { normalizeType } from '@agent-device/contracts/snapshot';
import type {
  IosSnapshotAcquisition,
  IosSnapshotInput,
} from '@agent-device/contracts/ios-snapshot';
import {
  createIosSnapshotRequest,
  deriveIosCaptureHint,
} from '@agent-device/capture-kit/ios-snapshot-planning';
import type { RawSnapshotNode, Rect } from '@agent-device/kernel/snapshot';
import { presentIosSnapshot } from './index.ts';

// ADR 0026: `REGULAR_ELIGIBLE_TYPES` (TypeScript) and `eligibleInteractiveTypes` (Swift) are one
// fact in two languages — the set that lets a scroll host survive regular projection so the
// parent-edge ownership rule can find it. No runtime shares the two lists, so this guard reads both
// literals from source and fails if they drift. Parsing source (rather than a production export)
// keeps the sets private to their modules while still enforcing parity.

const TYPESCRIPT_PROJECTION = path.join(import.meta.dirname, 'projection.ts');
const SWIFT_PROJECTION = path.join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  '..',
  'apple',
  'snapshot-presentation',
  'Sources',
  'AgentDeviceSnapshotPresentation',
  'SnapshotPresentationProjection.swift',
);

const SHARED_MEMBERS = [
  'button',
  'cell',
  'collectionview',
  'scrollview',
  'table',
  'textview',
  'webview',
] as const;

const TYPESCRIPT_LITERAL = /const REGULAR_ELIGIBLE_TYPES = new Set\(\[([\s\S]*?)\]\)/;
const SWIFT_LITERAL = /eligibleInteractiveTypes: Set<String> = \[([\s\S]*?)\]/;

test('the two regular-eligibility lists are one fact in two languages', () => {
  const typescript = normalizedEligible(readSource(TYPESCRIPT_PROJECTION), TYPESCRIPT_LITERAL);
  const swift = normalizedEligible(readSource(SWIFT_PROJECTION), SWIFT_LITERAL);

  // A regex that stopped matching would yield an empty set and pass by accident; pin non-emptiness
  // and the scroll-host members that carry the ownership rule.
  assert.ok(typescript.size >= SHARED_MEMBERS.length, 'TypeScript eligibility list parsed empty');
  assert.ok(swift.size >= SHARED_MEMBERS.length, 'Swift eligibility list parsed empty');
  for (const member of SHARED_MEMBERS) {
    assert.ok(typescript.has(member), `TypeScript list missing ${member}`);
    assert.ok(swift.has(member), `Swift list missing ${member}`);
  }
  assert.deepEqual(
    [...typescript].sort(),
    [...swift].sort(),
    'REGULAR_ELIGIBLE_TYPES and eligibleInteractiveTypes diverged',
  );

  // Spelling discipline. Normalized equality alone hides a casing flip that breaks only one runtime,
  // because each matches `node.type` differently: TypeScript normalizes before lookup
  // (`projection.ts` `.has(normalizeType(node.type))`), so its members must already be normalized;
  // Swift matches the raw producer spelling (`contains(node.type)`), so its members must stay in the
  // un-normalized PascalCase the Apple producer emits. Without this, lowercasing the Swift literals
  // would keep the normalized parity check green while silently dropping every macOS row.
  for (const raw of rawEligible(readSource(TYPESCRIPT_PROJECTION), TYPESCRIPT_LITERAL)) {
    assert.equal(raw, normalizeType(raw), `TypeScript literal "${raw}" is not in normalized form`);
  }
  for (const raw of rawEligible(readSource(SWIFT_PROJECTION), SWIFT_LITERAL)) {
    assert.notEqual(
      raw,
      normalizeType(raw),
      `Swift literal "${raw}" was normalized; Swift matches raw node.type`,
    );
  }
});

// `scrollarea` is accepted by `isScrollableSnapshotType` yet excluded from both eligible sets: the
// iOS runner never emits it, and macOS desktop capture reaches these rules through the same engine.
// The macOS surface is answered with a case below rather than by admitting the type for iOS's sake.
test('the eligible sets deliberately exclude the macOS-only scrollarea type', () => {
  const typescript = normalizedEligible(readSource(TYPESCRIPT_PROJECTION), TYPESCRIPT_LITERAL);
  const swift = normalizedEligible(readSource(SWIFT_PROJECTION), SWIFT_LITERAL);
  assert.equal(typescript.has('scrollarea'), false);
  assert.equal(swift.has('scrollarea'), false);
});

// macOS desktop capture (snapshot-desktop-surface → ios-snapshot-runtime → publishIosSnapshot) uses
// these rules and its helper emits `ScrollArea` from AXScrollArea. The decision: keep the type out
// of the eligible sets. A `ScrollArea` that carries content survives eligibility and owns its band
// under the parent-edge rule; a label-less one is dropped and its indicator resolves no owner, which
// under-clips (safe) rather than mis-clipping the enclosing list — strictly safer than the retired
// ancestor walk, which could re-attribute the re-parented indicator to an unrelated scroll host.
test('a content-bearing ScrollArea scroll host owns its band on the shared engine', () => {
  const viewport: Rect = { x: 0, y: 0, width: 320, height: 240 };
  const result = presentInteractive([
    node(0, 'Application', 'Finder', viewport),
    node(1, 'ScrollArea', 'Documents', { x: 0, y: 40, width: 320, height: 200 }, 0),
    node(
      2,
      'Other',
      'Vertical scroll bar, 3 pages',
      { x: 306, y: 40, width: 10, height: 150 },
      1,
      '0%',
    ),
    node(3, 'Button', 'Row above', { x: 16, y: -40, width: 288, height: 28 }, 1),
    node(4, 'Button', 'Row visible', { x: 16, y: 60, width: 288, height: 28 }, 1),
    node(5, 'Button', 'Row below', { x: 16, y: 200, width: 288, height: 28 }, 1),
  ]);
  const scrollArea = result.nodes.find((entry) => entry.type === 'ScrollArea');
  const labels = result.nodes.map((entry) => entry.label);

  assert.ok(scrollArea, 'a content-bearing ScrollArea must survive regular projection');
  assert.deepEqual(scrollArea?.rect, { x: 0, y: 40, width: 320, height: 150 });
  assert.equal(scrollArea?.hiddenContentBelow, true);
  assert.deepEqual(
    labels.filter((label) => label?.startsWith('Row ')),
    ['Row visible'],
  );
});

// Decision pin from the other side of the same rule. Because `scrollarea` is excluded from both
// eligible sets, a label-less ScrollArea carries no semantic content to survive on and is dropped
// from regular projection — the type simply does not appear, whichever producer reaches the engine.
// Admitting `scrollarea` would make it survive as a node, failing the absence assertion below. (The
// dropped host's own indicator still bands the tree it leaves behind; that band is a separate concern
// from eligibility, so this case only pins the survival decision.)
test('a label-less ScrollArea does not survive regular projection', () => {
  const viewport: Rect = { x: 0, y: 0, width: 320, height: 240 };
  const result = presentInteractive([
    node(0, 'Application', 'Finder', viewport),
    node(1, 'ScrollArea', undefined, { x: 0, y: 40, width: 320, height: 200 }, 0),
    node(
      2,
      'Other',
      'Vertical scroll bar, 3 pages',
      { x: 306, y: 40, width: 10, height: 150 },
      1,
      '0%',
    ),
    node(3, 'Button', 'Row above', { x: 16, y: -40, width: 288, height: 28 }, 1),
    node(4, 'Button', 'Row visible', { x: 16, y: 60, width: 288, height: 28 }, 1),
    node(5, 'Button', 'Row below', { x: 16, y: 200, width: 288, height: 28 }, 1),
  ]);

  assert.equal(
    result.nodes.find((entry) => entry.type === 'ScrollArea'),
    undefined,
    'a label-less ScrollArea must not survive regular projection',
  );
});

function readSource(file: string): string {
  return fs.readFileSync(file, 'utf8');
}

function normalizedEligible(source: string, literal: RegExp): Set<string> {
  return new Set(rawEligible(source, literal).map((member) => normalizeType(member)));
}

function rawEligible(source: string, literal: RegExp): string[] {
  const body = source.match(literal)?.[1];
  assert.ok(body, 'eligibility list literal not found — did it get renamed?');
  return [...body.matchAll(/["']([^"']+)["']/g)].map((match) => match[1]!);
}

function presentInteractive(nodes: RawSnapshotNode[]) {
  const request = createIosSnapshotRequest({
    projection: 'regular',
    interactiveOnly: true,
    acquisitionIntent: 'full',
  });
  const acquisition: IosSnapshotAcquisition = {
    producer: 'simulator-ax-bridge',
    intent: 'full',
    hint: { ...deriveIosCaptureHint(request), acquisitionIntent: 'full' },
    nodes,
    truncated: false,
    viewport: { kind: 'reported', rect: { x: 0, y: 0, width: 320, height: 240 } },
    lineage: { targetId: 'parity-target', generation: 'parity-generation' },
    residue: [],
  };
  const input: IosSnapshotInput = { stage: 'acquired', acquisition };
  return presentIosSnapshot(input, request);
}

function node(
  index: number,
  type: string,
  label: string | undefined,
  rect: Rect,
  parentIndex?: number,
  value?: string,
): RawSnapshotNode {
  return {
    index,
    type,
    ...(label ? { label } : {}),
    ...(value ? { value } : {}),
    rect,
    enabled: true,
    hittable: true,
    depth: parentIndex === undefined ? 0 : 1,
    ...(parentIndex === undefined ? {} : { parentIndex }),
  };
}
