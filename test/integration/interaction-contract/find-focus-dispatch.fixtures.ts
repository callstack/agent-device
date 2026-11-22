export const APPLICATION_NODE = {
  index: 0,
  type: 'Application',
  rect: { x: 0, y: 0, width: 400, height: 800 },
};

export function labelledWrapperTree(): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Email',
      rect: { x: 20, y: 100, width: 360, height: 80 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'TextField',
      rect: { x: 32, y: 130, width: 336, height: 40 },
      hittable: true,
    },
  ];
}

export function fieldFillingCellTree(): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Cell',
      label: 'Email',
      rect: { x: 0, y: 100, width: 400, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'TextField',
      rect: { x: 16, y: 100, width: 368, height: 44 },
      hittable: true,
    },
  ];
}

export function labelBesideFieldTree(): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Other',
      rect: { x: 20, y: 100, width: 360, height: 80 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Email',
      rect: { x: 32, y: 100, width: 336, height: 24 },
      hittable: false,
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'TextField',
      rect: { x: 32, y: 130, width: 336, height: 40 },
      hittable: true,
    },
  ];
}

export function namedFieldBesideSiblingTree({ enabled }: { enabled: boolean }): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Other',
      rect: { x: 20, y: 100, width: 360, height: 160 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'TextView',
      label: 'Notes',
      enabled,
      rect: { x: 32, y: 130, width: 336, height: 40 },
      hittable: false,
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'TextField',
      label: 'Title',
      rect: { x: 32, y: 200, width: 336, height: 40 },
      hittable: true,
    },
  ];
}

export function twoFieldsTree(): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Other',
      label: 'Address',
      rect: { x: 20, y: 100, width: 360, height: 160 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'TextField',
      label: 'Street',
      rect: { x: 32, y: 130, width: 336, height: 40 },
      hittable: true,
    },
    {
      index: 3,
      parentIndex: 1,
      type: 'TextField',
      label: 'City',
      rect: { x: 32, y: 200, width: 336, height: 40 },
      hittable: true,
    },
  ];
}

export function partlyTiledCardTree(): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Link',
      label: 'Card',
      rect: { x: 20, y: 100, width: 360, height: 200 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'Button',
      label: 'Action',
      rect: { x: 20, y: 180, width: 360, height: 40 },
      hittable: true,
    },
  ];
}

export function nonHittableRowTree(): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Cell',
      rect: { x: 40, y: 160, width: 320, height: 80 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 1,
      type: 'StaticText',
      label: 'Notifications',
      rect: { x: 60, y: 180, width: 160, height: 30 },
      hittable: false,
    },
  ];
}

export function coveredFormTree(): unknown[] {
  return [
    { index: 0, type: 'Application', rect: { x: 0, y: 0, width: 390, height: 844 } },
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 16, y: 790, width: 140, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'TabBar',
      rect: { x: 0, y: 760, width: 390, height: 84 },
      hittable: true,
    },
  ];
}

export function twinFormTree(): unknown[] {
  return [
    APPLICATION_NODE,
    {
      index: 1,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 40, y: 200, width: 120, height: 44 },
      hittable: true,
    },
    {
      index: 2,
      parentIndex: 0,
      type: 'Button',
      label: 'Form',
      rect: { x: 240, y: 200, width: 120, height: 44 },
      hittable: true,
    },
  ];
}
