import { describe, expect, test } from 'vitest';

import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

import { collectIosStructuralIdentifierSuppression } from './noise.ts';
import type { SnapshotTreeRuleContext } from '../tree.ts';

type ReadCounter = { reads: number };

function countingNode(base: RawSnapshotNode, counter: ReadCounter): RawSnapshotNode {
  return {
    ...base,
    get index() {
      counter.reads += 1;
      return base.index;
    },
    get parentIndex(): number | undefined {
      counter.reads += 1;
      return base.parentIndex;
    },
  };
}

function makeStructuralTree(
  candidateCount: number,
  descendantsPerCandidate: number,
): {
  nodes: RawSnapshotNode[];
  counter: ReadCounter;
} {
  const counter: ReadCounter = { reads: 0 };
  const plain: RawSnapshotNode[] = [{ index: 0, type: 'Application', label: 'App' }];
  let nextIndex = 1;
  for (let candidate = 0; candidate < candidateCount; candidate += 1) {
    const candidateIndex = nextIndex;
    plain.push({
      index: candidateIndex,
      parentIndex: 0,
      type: 'Other',
      identifier: `wrapper-${candidate}`,
    });
    nextIndex += 1;
    for (let descendant = 0; descendant < descendantsPerCandidate; descendant += 1) {
      plain.push({
        index: nextIndex,
        parentIndex: candidateIndex,
        type: 'StaticText',
        label: `content ${candidate}-${descendant}`,
      });
      nextIndex += 1;
    }
  }
  return { nodes: plain.map((node) => countingNode(node, counter)), counter };
}

function makeRuleContext(nodes: RawSnapshotNode[]): SnapshotTreeRuleContext {
  return {
    replacements: new Map(),
    semanticRepresentativeIndexes: new Set(),
    sourceNodesByIndex: new Map(nodes.map((node) => [node.index, node])),
    isSuppressed: () => false,
    suppressNode: () => {},
  };
}

describe('collectIosStructuralIdentifierSuppression', () => {
  test('suppresses structural identifier wrappers, keeping their content published', () => {
    const { nodes } = makeStructuralTree(3, 2);
    const suppressed: number[] = [];
    const context: SnapshotTreeRuleContext = {
      ...makeRuleContext(nodes),
      suppressNode: (source) => suppressed.push(source.index),
    };

    collectIosStructuralIdentifierSuppression(nodes, context);

    expect(suppressed.sort((a, b) => a - b)).toEqual([1, 4, 7]);
  });

  test('builds the child index once instead of per structural candidate', () => {
    const candidateCount = 40;
    const descendantsPerCandidate = 25;
    const { nodes, counter } = makeStructuralTree(candidateCount, descendantsPerCandidate);
    const nodeCount = nodes.length;

    collectIosStructuralIdentifierSuppression(nodes, makeRuleContext(nodes));

    // The per-candidate implementation rebuilds a full node map and walks an
    // ancestor chain for every node once per candidate (~candidates x n
    // reads); the child-index implementation reads each node a constant
    // number of times plus one subtree pass per candidate. The bound sits far
    // above the healthy cost and far below the quadratic one.
    expect(counter.reads).toBeLessThan(
      4 * nodeCount + 8 * candidateCount * descendantsPerCandidate,
    );
  });
});
