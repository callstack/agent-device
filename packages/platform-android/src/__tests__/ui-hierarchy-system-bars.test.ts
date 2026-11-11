import { expect, test } from 'vitest';
import fc from 'fast-check';
import { parseUiHierarchy } from './ui-hierarchy-fixtures.ts';

function hierarchy(
  options: {
    packageName?: string;
    visible?: boolean;
    layer?: number;
    barBounds?: string;
    appBounds?: string;
    rowBounds?: string;
    resourceId?: string;
  } = {},
): string {
  const packageName = options.packageName ?? 'com.google.android.apps.nexuslauncher';
  const appBounds = options.appBounds ?? '[0,0][1080,2400]';
  const barBounds = options.barBounds ?? '[0,2274][1080,2400]';
  return `<hierarchy>
    <node class="android.widget.FrameLayout" package="${packageName}" bounds="${barBounds}" window-bounds="${barBounds}" window-index="0" window-type="3" window-layer="${options.layer ?? 10}" visible-to-user="${options.visible ?? true}">
      <node class="android.widget.FrameLayout" package="${packageName}" resource-id="${options.resourceId ?? `${packageName}:id/navbuttons_view`}" bounds="${barBounds}" visible-to-user="true">
        <node class="android.widget.ImageView" package="${packageName}" content-desc="Home" bounds="[434,2279][644,2395]" clickable="true" visible-to-user="true" />
      </node>
    </node>
    <node class="android.widget.FrameLayout" package="dev.e2e.benchmark" bounds="${appBounds}" window-bounds="${appBounds}" window-index="1" window-type="1" window-layer="1" visible-to-user="true">
      <node class="android.widget.ScrollView" package="dev.e2e.benchmark" bounds="${appBounds}" scrollable="true" visible-to-user="true">
        <node class="android.view.ViewGroup" package="dev.e2e.benchmark" resource-id="item-137" content-desc="Item 137" bounds="${options.rowBounds ?? '[0,2259][1080,2390]'}" clickable="true" visible-to-user="true" />
        <node class="android.view.ViewGroup" package="dev.e2e.benchmark" resource-id="item-138" content-desc="Item 138" bounds="[0,2305][1080,2400]" clickable="true" visible-to-user="true" />
      </node>
    </node>
  </hierarchy>`;
}

test('a scrolled row uses only the visible strip above launcher-owned navigation, while Home remains actionable', () => {
  const snapshot = parseUiHierarchy(hierarchy(), undefined, {});

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')).toMatchObject({
    rect: { x: 0, y: 2259, width: 1080, height: 15 },
    hittable: true,
  });
  expect(snapshot.nodes.find((node) => node.identifier === 'item-138')).toBeUndefined();
  expect(snapshot.nodes.find((node) => node.label === 'Home')).toMatchObject({
    rect: { x: 434, y: 2279, width: 210, height: 116 },
    hittable: true,
  });
});

test('raw Android snapshots retain bounds behind system navigation', () => {
  const snapshot = parseUiHierarchy(hierarchy(), undefined, { raw: true });

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')).toMatchObject({
    rect: { x: 0, y: 2259, width: 1080, height: 131 },
  });
  expect(snapshot.nodes.find((node) => node.identifier === 'item-138')).toBeDefined();
});

test('a measured status bar clips edge-to-edge app content', () => {
  const snapshot = parseUiHierarchy(
    hierarchy({
      packageName: 'com.android.systemui',
      resourceId: 'com.android.systemui:id/status_bar',
      barBounds: '[0,0][1080,132]',
      rowBounds: '[0,100][1080,200]',
    }),
    undefined,
    {},
  );

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')?.rect).toEqual({
    x: 0,
    y: 132,
    width: 1080,
    height: 68,
  });
});

test.each([
  { packageName: 'dev.e2e.benchmark' },
  { visible: false },
  { layer: 0 },
  { barBounds: '[0,1000][1080,1126]' },
])('unproven or non-covering navigation does not clip app content: %j', (options) => {
  const snapshot = parseUiHierarchy(hierarchy(options), undefined, {});

  expect(snapshot.nodes.find((node) => node.identifier === 'item-137')).toMatchObject({
    rect: { x: 0, y: 2259, width: 1080, height: 131 },
  });
});

test.each([
  {
    barBounds: '[0,0][126,1080]',
    rowBounds: '[100,0][231,1080]',
    expected: { x: 126, y: 0, width: 105, height: 1080 },
  },
  {
    barBounds: '[2274,0][2400,1080]',
    rowBounds: '[2259,0][2390,1080]',
    expected: { x: 2259, y: 0, width: 15, height: 1080 },
  },
  {
    barBounds: '[0,0][2400,126]',
    rowBounds: '[0,100][2400,231]',
    expected: { x: 0, y: 126, width: 2400, height: 105 },
  },
])(
  'system navigation clips its measured edge after rotation: $barBounds',
  ({ expected, ...options }) => {
    const snapshot = parseUiHierarchy(
      hierarchy({ ...options, appBounds: '[0,0][2400,1080]' }),
      undefined,
      {},
    );

    expect(snapshot.nodes.find((node) => node.identifier === 'item-137')?.rect).toEqual(expected);
  },
);

const PROPERTY_RUNS = 100;
const bottomBarOverlapArb = fc.record({
  width: fc.integer({ min: 200, max: 2000 }),
  height: fc.integer({ min: 400, max: 3000 }),
  barHeight: fc.integer({ min: 20, max: 120 }),
  visibleHeight: fc.integer({ min: 1, max: 19 }),
});

test('property: a partially visible row center stays above navigation and raw bounds stay intact', () => {
  fc.assert(
    fc.property(bottomBarOverlapArb, ({ width, height, barHeight, visibleHeight }) => {
      const edge = height - barHeight;
      const top = edge - visibleHeight;
      const xml = hierarchy({
        appBounds: `[0,0][${width},${height}]`,
        barBounds: `[0,${edge}][${width},${height}]`,
        rowBounds: `[0,${top}][${width},${height}]`,
      });
      const regular = parseUiHierarchy(xml, undefined, {});
      const raw = parseUiHierarchy(xml, undefined, { raw: true });
      const rect = regular.nodes.find((node) => node.identifier === 'item-137')!.rect!;

      expect(rect.y + rect.height / 2).toBeLessThan(edge);
      expect(raw.nodes.find((node) => node.identifier === 'item-137')?.rect).toEqual({
        x: 0,
        y: top,
        width,
        height: height - top,
      });
    }),
    { numRuns: PROPERTY_RUNS },
  );
});
