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
import type { IosTreeNode } from './snapshot.ts';

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

test('Limrun moves past a bottom group whose hit-tests find no tabs to the tab bar', async () => {
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree([
      limrunEmptyGroup({ x: 0, y: 854, width: 402, height: 20 }, 'Home Indicator Area'),
      limrunEmptyGroup(IPHONE_TAB_BAR_FRAME, 'Tab Bar'),
    ]),
    LIMRUN_TAB_BUTTONS,
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result).map((tab) => tab.label)).toEqual([
    'Home',
    'Catalog',
    'Form',
    'Audio',
    'Settings',
  ]);
  expect(tabsOf(result, 'Home Indicator Area')).toEqual([]);
  expect(probes.length).toBeLessThanOrEqual(24);
});

test('Limrun finds the tabs of a landscape iPhone tab bar', async () => {
  const screen = { width: 874, height: 402 };
  const labels = ['Home', 'Catalog', 'Form', 'Audio', 'Settings'];
  const { session, probes } = createLimrunHitTestSession(
    limrunScreenTree(
      [limrunEmptyGroup({ x: 0, y: 350, width: 874, height: 52 }, 'Tab Bar')],
      screen,
    ),
    labels.map((label, index) =>
      limrunTabButton(label, { x: 187 + index * 100, y: 352, width: 100, height: 44 }, index === 0),
    ),
    { screen },
  );
  const result = await captureLimrunIosSnapshot(session);

  expect(tabsOf(result).map((tab) => tab.label)).toEqual(labels);
  expect(probes.length).toBeLessThanOrEqual(24);
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
      return calls === 2 ? new Promise<IosTreeNode>(() => {}) : Promise.resolve(hit);
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
  hit: (point: { x: number; y: number }) => IosTreeNode[],
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
