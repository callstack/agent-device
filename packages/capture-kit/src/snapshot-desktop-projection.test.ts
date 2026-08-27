import { expect, test } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { scopeSnapshotNodes } from './snapshot-desktop-projection.ts';

test('scopeSnapshotNodes agrees with every golden scope-policy table case', () => {
  const cases = JSON.parse(
    fs.readFileSync(
      path.resolve(import.meta.dirname, '../../../contracts/fixtures/snapshot-scope-policy.json'),
      'utf8',
    ),
  ) as Array<{
    name: string;
    scope: string;
    nodes: Array<{
      depth: number;
      label?: string;
      value?: string;
      identifier?: string;
      presented?: boolean;
    }>;
    expectedSubtreeIndexes: number[];
  }>;
  expect(cases.length).toBeGreaterThan(0);
  for (const fixture of cases) {
    const parents: number[] = [];
    const nodes = fixture.nodes.map((node, index) => {
      parents.length = node.depth;
      const parentIndex = node.depth > 0 ? parents[node.depth - 1] : undefined;
      parents[node.depth] = index;
      return { ...node, index, parentIndex, rect: { x: index, y: 0, width: 1, height: 1 } };
    });
    const scoped = scopeSnapshotNodes(nodes, fixture.scope, (range) =>
      nodes.slice(range.start, range.end).some((node) => node.presented !== false),
    );
    expect(
      scoped.map((node) => node.rect?.x),
      fixture.name,
    ).toEqual(fixture.expectedSubtreeIndexes);
    if (scoped.length > 0) expect(scoped[0]?.depth, fixture.name).toBe(0);
  }
});
