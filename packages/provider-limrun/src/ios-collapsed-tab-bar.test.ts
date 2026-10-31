import { readFileSync } from 'node:fs';
import { presentIosSnapshotAcquisition } from '@agent-device/capture-kit/ios-snapshot-runtime';
import type { SnapshotRuntimeAcquiredResult } from '@agent-device/contracts/interactor-types';
import { afterEach, expect, test, vi } from 'vitest';
import { captureLimrunIosSnapshot } from './ios-snapshot-adapter.ts';
import {
  IPHONE_TAB_BAR_FRAME,
  LIMRUN_TAB_BUTTONS,
  createLimrunHitTestSession,
  limrunCollapsedTabBarTree,
  limrunEmptyGroup,
  limrunScreenTree,
  limrunTabButton,
} from './ios-snapshot-adapter.fixtures.ts';
import type { AxeTreeNode } from '@agent-device/capture-kit/ios-axe-tree';

afterEach(() => {
  vi.useRealTimers();
});

function tabsOf(result: SnapshotRuntimeAcquiredResult, barLabel = 'Tab Bar') {
  const { nodes } = result.acquisition;
  const bar = nodes.find((node) => node.label === barLabel)!;
  return nodes.filter((node) => node.parentIndex === bar.index);
}

test('Limrun publishes the tabs its hit-tests find inside a collapsed iOS tab bar', async () => {
  const { session, probes } = createLimrunHitTestSession(
    limrunCollapsedTabBarTree(),
    LIMRUN_TAB_BUTTONS,
  );
  const result = await captureLimrunIosSnapshot(session);
  const bar = result.acquisition.nodes.find((node) => node.label === 'Tab Bar')!;
  const tabs = tabsOf(result);

  expect(tabs.map((tab) => tab.label)).toEqual(['Home', 'Catalog', 'Form', 'Audio', 'Settings']);
  expect(tabs[0]).toMatchObject({
    type: 'RadioButton',
    rect: { x: 25, y: 795, width: 74, height: 54 },
    selected: true,
    depth: (bar.depth ?? 0) + 1,
  });
  expect(tabs.filter((tab) => tab.selected).map((tab) => tab.label)).toEqual(['Home']);
  expect(probes.length).toBeLessThanOrEqual(24);
  expect(result.acquisition.residue).not.toContainEqual(
    expect.objectContaining({ kind: 'collapsed-tab-bar-probe-failed' }),
  );
});

const FIVE_TABS = ['Home', 'Catalog', 'Form', 'Audio', 'Settings'];
const LANDSCAPE = { width: 874, height: 402 };

function landscapeTabs(y: number, height: number) {
  return FIVE_TABS.map((label, index) =>
    limrunTabButton(label, { x: 187 + index * 100, y, width: 100, height }, index === 0),
  );
}

test('Limrun probes the tab bar before a home indicator strip that precedes it', async () => {
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree([
      limrunEmptyGroup({ x: 0, y: 854, width: 402, height: 20 }, 'Home Indicator Area'),
      limrunEmptyGroup(IPHONE_TAB_BAR_FRAME, 'Tab Bar'),
    ]),
    LIMRUN_TAB_BUTTONS,
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result).map((tab) => tab.label)).toEqual(FIVE_TABS);
  expect(tabsOf(result, 'Home Indicator Area')).toEqual([]);
  expect(new Set(probes.map((point) => point.y))).toEqual(new Set([832.5]));
});

test('Limrun moves past a lower bar-sized group whose hit-tests find no tabs', async () => {
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree([
      limrunEmptyGroup({ x: 0, y: 830, width: 402, height: 44 }, 'Toolbar'),
      limrunEmptyGroup(IPHONE_TAB_BAR_FRAME, 'Tab Bar'),
    ]),
    LIMRUN_TAB_BUTTONS,
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result).map((tab) => tab.label)).toEqual(FIVE_TABS);
  expect(tabsOf(result, 'Toolbar')).toEqual([]);
  // Both candidates were hit-tested along their own midlines, inside one budget.
  expect(new Set(probes.map((point) => point.y))).toEqual(new Set([852, 832.5]));
  expect(probes.length).toBeLessThanOrEqual(24);
});

test('Limrun finds the tabs of a landscape iPhone tab bar', async () => {
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree(
      [limrunEmptyGroup({ x: 0, y: 350, width: 874, height: 52 }, 'Tab Bar')],
      LANDSCAPE,
    ),
    landscapeTabs(352, 44),
    { screen: LANDSCAPE },
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result).map((tab) => tab.label)).toEqual(FIVE_TABS);
  expect(probes.length).toBeLessThanOrEqual(24);
});

test('Limrun finds a landscape tab bar behind a full-width decoy that precedes it', async () => {
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree(
      [
        limrunEmptyGroup({ x: 0, y: 252, width: 874, height: 150 }, 'Backdrop'),
        limrunEmptyGroup({ x: 0, y: 350, width: 874, height: 52 }, 'Tab Bar'),
      ],
      LANDSCAPE,
    ),
    landscapeTabs(352, 44),
    { screen: LANDSCAPE },
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result).map((tab) => tab.label)).toEqual(FIVE_TABS);
  expect(probes.length).toBeLessThanOrEqual(24);
});

test('Limrun reports a tab bar the probe budget could not reach', async () => {
  // Both groups are bar-sized; the lower one is probed first, finds nothing, and leaves too few
  // probes to cover the 874-point bar above it.
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree(
      [
        limrunEmptyGroup({ x: 0, y: 330, width: 874, height: 72 }, 'Tab Bar'),
        limrunEmptyGroup({ x: 0, y: 356, width: 874, height: 46 }, 'Toolbar'),
      ],
      LANDSCAPE,
    ),
    landscapeTabs(334, 40),
    { screen: LANDSCAPE },
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result)).toEqual([]);
  expect(probes.length).toBeLessThan(24);
  expect(result.acquisition.residue).toContainEqual({
    kind: 'collapsed-tab-bar-probe-failed',
    reason: 'budget-exhausted',
  });
});

test('Limrun reports no miss for a strip too wide to probe without a tab bar height', async () => {
  const screen = { width: 1194, height: 834 };
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree([limrunEmptyGroup({ x: 0, y: 814, width: 1194, height: 20 })], screen),
    [],
    { screen },
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(probes).toEqual([]);
  expect(result.acquisition.residue).not.toContainEqual(
    expect.objectContaining({ kind: 'collapsed-tab-bar-probe-failed' }),
  );
});

test('Limrun reports a bar with a tab bar height that is too wide to probe', async () => {
  const screen = { width: 1194, height: 834 };
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree([limrunEmptyGroup({ x: 0, y: 784, width: 1194, height: 50 })], screen),
    [],
    { screen },
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(probes).toEqual([]);
  expect(result.acquisition.residue).toContainEqual({
    kind: 'collapsed-tab-bar-probe-failed',
    reason: 'budget-exhausted',
  });
});

test('Limrun probes no childless group that is not docked along the bottom edge', async () => {
  const { session, probes } = createLimrunHitTestSession(
    limrunCollapsedTabBarTree({ x: 0, y: 62, width: 402, height: 83 }),
    LIMRUN_TAB_BUTTONS.map((tab) => ({ ...tab, frame: { ...tab.frame!, y: 66 } })),
  );

  expect(tabsOf(await captureLimrunIosSnapshot(session))).toEqual([]);
  expect(probes).toEqual([]);
});

test('Limrun publishes no hit-test result that is not a tab button', async () => {
  const { session } = createLimrunHitTestSession(
    limrunCollapsedTabBarTree(),
    LIMRUN_TAB_BUTTONS.map((tab) => ({ ...tab, type: 'Button', traits: ['Button'] })),
  );

  expect(tabsOf(await captureLimrunIosSnapshot(session))).toEqual([]);
});

test('Limrun keeps a tab bar unexpanded and reports it when one hit-test fails', async () => {
  let calls = 0;
  const { session } = createLimrunHitTestSession(limrunCollapsedTabBarTree(), LIMRUN_TAB_BUTTONS, {
    hitTest: async (_point, hit) => {
      calls += 1;
      if (calls === 3) throw new Error('socket closed');
      return hit;
    },
  });
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result)).toEqual([]);
  expect(result.acquisition.residue).toContainEqual({
    kind: 'collapsed-tab-bar-probe-failed',
    reason: 'rejected',
  });
  const expanded = createLimrunHitTestSession(limrunCollapsedTabBarTree(), LIMRUN_TAB_BUTTONS);
  const baseline = presentIosSnapshotAcquisition(await captureLimrunIosSnapshot(expanded.session));
  expect(presentIosSnapshotAcquisition(result).warnings?.length).toBe(
    (baseline.warnings?.length ?? 0) + 1,
  );
});

test('Limrun stops waiting for a hung hit-test well before the SDK request timeout', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const { session } = createLimrunHitTestSession(limrunCollapsedTabBarTree(), LIMRUN_TAB_BUTTONS, {
    hitTest: (_point, hit) => {
      calls += 1;
      return calls === 2 ? new Promise<AxeTreeNode>(() => {}) : Promise.resolve(hit);
    },
  });
  let result: SnapshotRuntimeAcquiredResult | undefined;
  void captureLimrunIosSnapshot(session).then((value) => {
    result = value;
  });
  await vi.advanceTimersByTimeAsync(2_000);

  expect(result).toBeDefined();
  expect(tabsOf(result!)).toEqual([]);
  expect(result!.acquisition.residue).toContainEqual({
    kind: 'collapsed-tab-bar-probe-failed',
    reason: 'timed-out',
  });
});

type GoldenRect = { x: number; y: number; width: number; height: number };
const geometry = JSON.parse(
  readFileSync(
    new URL('../../../contracts/fixtures/ios-collapsed-tab-geometry.json', import.meta.url),
    'utf8',
  ),
) as {
  containers: { name: string; frame: GoldenRect; expected: boolean }[];
  candidates: { name: string; container: GoldenRect; frame: GoldenRect; expected: boolean }[];
  rows: { name: string; container: GoldenRect; midpoints: number[]; expected: boolean }[];
};

/** A screen whose viewport ends at `container`, so the container is docked along its bottom edge. */
function dockedScreen(container: GoldenRect) {
  return { x: container.x, width: container.width, height: container.y + container.height };
}

function dockedSession(
  container: GoldenRect,
  hit: (point: { x: number; y: number }) => AxeTreeNode[],
) {
  const screen = dockedScreen(container);
  const tree = limrunScreenTree([limrunEmptyGroup(container, 'Tab Bar')], screen);
  tree[0]!.frame = { x: screen.x, y: 0, width: screen.width, height: screen.height };
  return createLimrunHitTestSession(tree, [], {
    screen,
    hitTest: async (point) => hit(point),
  });
}

for (const row of geometry.containers) {
  test(`collapsed tab golden container: ${row.name}`, async () => {
    const { session, probes } = dockedSession(row.frame, () => []);
    await captureLimrunIosSnapshot(session);
    expect(probes.length > 0).toBe(row.expected);
  });
}

for (const row of geometry.candidates) {
  test(`collapsed tab golden candidate: ${row.name}`, async () => {
    // Two distinct tabs with the same frame, so only the candidate rule decides.
    const { session } = dockedSession(row.container, () => [
      limrunTabButton('Left', row.frame),
      limrunTabButton('Twin', row.frame),
    ]);
    const tabs = tabsOf(await captureLimrunIosSnapshot(session));
    expect(tabs.length === 2).toBe(row.expected);
  });
}

for (const row of geometry.rows) {
  test(`collapsed tab golden row: ${row.name}`, async () => {
    const items = row.midpoints.map((midpoint, index) =>
      limrunTabButton(`Tab ${index}`, {
        x: row.container.x + 20 + index * 70,
        y: midpoint - 5,
        width: 60,
        height: 10,
      }),
    );
    const { session } = dockedSession(row.container, () => items);
    const tabs = tabsOf(await captureLimrunIosSnapshot(session));
    expect(tabs.length === items.length).toBe(row.expected);
  });
}

const traitClassification = JSON.parse(
  readFileSync(
    new URL('../../../contracts/fixtures/ios-trait-classification.json', import.meta.url),
    'utf8',
  ),
) as {
  cases: Array<{
    name: string;
    limrun?: {
      fact: string;
      seam: string;
      input: AxeTreeNode;
      expected: { tabCandidate: boolean };
    };
  }>;
};
for (const row of traitClassification.cases.filter((entry) => entry.limrun?.seam === 'tab')) {
  test(`Limrun trait tab golden: ${row.limrun!.fact}`, async () => {
    const frame = { x: 25, y: 795, width: 74, height: 54 };
    const { session } = dockedSession({ x: 0, y: 791, width: 402, height: 83 }, () => [
      { ...row.limrun!.input, label: 'Left', frame },
      { ...row.limrun!.input, label: 'Right', frame },
    ]);
    expect(tabsOf(await captureLimrunIosSnapshot(session)).length === 2).toBe(
      row.limrun!.expected.tabCandidate,
    );
  });
}
