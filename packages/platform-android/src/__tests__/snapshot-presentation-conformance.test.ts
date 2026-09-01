import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';
import type { Rect } from '@agent-device/kernel/snapshot';

type ConformanceNode = {
  index: number;
  type: string;
  label: string;
  rect: Rect;
  depth: number;
  parentIndex: number | null;
  hittable: boolean;
};

type ConformanceExpectedNode = {
  label: string;
  rect: Rect;
  depth: number;
  parentIndex: number | null;
  hittable: boolean;
};

type ConformanceFixture = {
  version: number;
  viewport: Rect;
  cases: Array<{
    name: string;
    projection: 'regular' | 'raw';
    scope: string | null;
    nodes: ConformanceNode[];
    expected: ConformanceExpectedNode[];
  }>;
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '../../../../contracts/fixtures/snapshot-presentation-conformance.json',
);

function conformanceXml(fixture: ConformanceFixture, nodes: ConformanceNode[]): string {
  const viewport = fixture.viewport;
  const windowBounds = `[${viewport.x},${viewport.y}][${viewport.x + viewport.width},${viewport.y + viewport.height}]`;
  const lines = ['<hierarchy>'];
  const openDepths: number[] = [];

  for (const node of nodes) {
    while (openDepths.length > node.depth) {
      openDepths.pop();
      lines.push('</node>');
    }
    const scrollable = ['ScrollView', 'CollectionView', 'Table'].includes(node.type);
    const attrs = [
      `class="android.widget.${node.type === 'Application' ? 'FrameLayout' : node.type}"`,
      `bounds="[${node.rect.x},${node.rect.y}][${node.rect.x + node.rect.width},${node.rect.y + node.rect.height}]"`,
      `window-bounds="${windowBounds}"`,
      'visible-to-user="true"',
      'enabled="true"',
      `text="${node.label}"`,
      ...(node.hittable ? ['clickable="true"'] : []),
      ...(scrollable ? ['scrollable="true"'] : []),
    ];
    lines.push(`<node ${attrs.join(' ')}>`);
    openDepths.push(node.depth);
  }
  while (openDepths.length > 0) {
    openDepths.pop();
    lines.push('</node>');
  }
  lines.push('</hierarchy>');
  return lines.join('\n');
}

test('Android XML parsing and presentation match the shared acquisition-to-presentation fixture', () => {
  const fixture = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as ConformanceFixture;
  assert.equal(fixture.version, 1);
  assert.ok(fixture.cases.length > 0);

  for (const testCase of fixture.cases) {
    const built = buildUiHierarchySnapshot(
      parseUiHierarchyTree(conformanceXml(fixture, testCase.nodes)),
      undefined,
      {
        ...(testCase.projection === 'raw' ? { raw: true } : {}),
        ...(testCase.scope === null ? {} : { scope: testCase.scope }),
        androidPresentation: { deadlineAtMs: Number.POSITIVE_INFINITY },
      },
    );
    const actual = built.nodes.map((node) => ({
      label: node.label ?? '',
      rect: node.rect,
      depth: node.depth,
      parentIndex: node.parentIndex ?? null,
      hittable: node.hittable === true,
    }));
    assert.deepEqual(actual, testCase.expected, testCase.name);
  }
});
