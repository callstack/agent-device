import type { RawSnapshotNode } from '@agent-device/kernel/snapshot';

const edge = { x: 0, y: 152, width: 180, height: 21 };

export function elementSettingsNodes(): RawSnapshotNode[] {
  return [
    {
      index: 0,
      depth: 0,
      type: 'Application',
      label: 'Element',
      rect: { x: 0, y: 0, width: 402, height: 874 },
    },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      rect: { x: 0, y: 152, width: 402, height: 660 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Visible table heading',
      rect: edge,
      hittable: false,
    },
    {
      index: 3,
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Pinned flattened heading',
      rect: edge,
      hittable: true,
    },
    {
      index: 4,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Visible row',
      rect: { x: 0, y: 251, width: 402, height: 44 },
      hittable: true,
    },
    {
      index: 5,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Language',
      rect: { x: 0, y: 2_000, width: 402, height: 44 },
      hittable: false,
    },
    {
      index: 6,
      depth: 3,
      parentIndex: 5,
      type: 'StaticText',
      label: 'Language',
      rect: edge,
      hittable: false,
    },
    {
      index: 7,
      depth: 4,
      parentIndex: 5,
      type: 'StaticText',
      label: 'Hidden language detail',
      rect: { x: 0, y: 2_000, width: 180, height: 21 },
      hittable: false,
    },
    {
      index: 8,
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Theme',
      rect: edge,
      hittable: true,
    },
    {
      index: 9,
      depth: 4,
      parentIndex: 8,
      type: 'StaticText',
      label: 'Theme detail',
      rect: edge,
      hittable: false,
    },
    {
      index: 10,
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Auto',
      rect: edge,
      hittable: false,
    },
    {
      index: 11,
      depth: 3,
      parentIndex: 1,
      type: 'Switch',
      rect: edge,
      hittable: true,
    },
    {
      index: 12,
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Message bubbles',
      rect: edge,
      hittable: false,
    },
    {
      index: 13,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      label: 'Partially clipped row',
      rect: { x: 0, y: 100, width: 402, height: 60 },
      hittable: true,
    },
    {
      index: 14,
      depth: 3,
      parentIndex: 13,
      type: 'StaticText',
      label: 'Visible clipped child',
      rect: { x: 20, y: 153, width: 160, height: 7 },
      hittable: true,
    },
    {
      index: 15,
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Visible co-located label',
      rect: { x: 0, y: 300, width: 180, height: 21 },
      hittable: true,
    },
    {
      index: 16,
      depth: 3,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Visible co-located value',
      rect: { x: 0, y: 300, width: 180, height: 21 },
      hittable: false,
    },
    {
      index: 17,
      depth: 3,
      parentIndex: 1,
      type: 'Switch',
      rect: { x: 0, y: 300, width: 180, height: 21 },
      hittable: true,
    },
  ];
}

export function collapsedBoundaryNodes(options: {
  candidateCount: number;
  separator: boolean;
}): RawSnapshotNode[] {
  const nodes: RawSnapshotNode[] = [
    { index: 0, depth: 0, type: 'Application' },
    {
      index: 1,
      depth: 1,
      parentIndex: 0,
      type: 'Table',
      rect: { x: 0, y: 100, width: 300, height: 500 },
    },
    {
      index: 2,
      depth: 2,
      parentIndex: 1,
      type: 'Cell',
      rect: { x: 0, y: 2_000, width: 300, height: 40 },
    },
    { index: 3, depth: 3, parentIndex: 2, type: 'StaticText', rect: edge },
  ];
  if (options.separator) {
    nodes.push({ index: 4, depth: 2, parentIndex: 1, type: 'Cell', rect: edge });
  }
  const firstCandidateIndex = nodes.length;
  nodes.push(
    ...Array.from({ length: options.candidateCount }, (_, offset) => ({
      index: firstCandidateIndex + offset,
      depth: 3,
      parentIndex: 1,
      type: offset === options.candidateCount - 1 ? 'Switch' : 'StaticText',
      label: `Visible composite ${offset + 1}`,
      hittable: offset === options.candidateCount - 1,
      rect: edge,
    })),
  );
  return nodes;
}
