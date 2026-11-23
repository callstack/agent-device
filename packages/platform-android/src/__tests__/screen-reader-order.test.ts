import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { readSnapshotScreenReaderOrderEvidence } from '@agent-device/contracts/capture';
import type { AndroidNode } from '../ui-hierarchy-node.ts';
import { parseUiHierarchyTree } from '../ui-hierarchy.ts';
import { parseUiHierarchy } from '../ui-hierarchy.fixtures.ts';
import { androidSnapshotPublicationInput } from '../snapshot-capture.ts';
import { estimateTalkBackOrder } from '../screen-reader-order.ts';

type TalkBackWalk = {
  visited: string[];
  /** Swipes from these bounds that TalkBack makes differently from the estimate, with the reason. */
  knownMisses?: { from: string; reason: string }[];
};

/**
 * Snapshot helper captures from an Android 17 emulator, each with the nodes TalkBack 17 focused
 * while one-finger swipes walked the screen, by bounds and in visit order.
 */
function talkBackFixture(name: string): { xml: string } & TalkBackWalk {
  const read = (file: string) =>
    readFileSync(new URL(`../fixtures/talkback/${file}`, import.meta.url), 'utf8');
  return {
    xml: read(`${name}.xml`),
    ...(JSON.parse(read(`${name}.talkback.json`)) as TalkBackWalk),
  };
}

function boundsText(node: AndroidNode): string {
  const rect = node.rect!;
  return `[${rect.x},${rect.y}][${rect.x + rect.width},${rect.y + rect.height}]`;
}

// The Compose dev launcher chains traversal links, the clock hides label-less stops from the
// snapshot, the dialog is its own window, and the React Native screen holds views that are not
// important for accessibility.
test.each(['compose-clock', 'compose-dev-launcher', 'permission-dialog', 'react-native-form'])(
  '%s: every swipe TalkBack made within a window lands on the estimated next stop',
  (name) => {
    const { xml, visited, knownMisses = [] } = talkBackFixture(name);
    const windows = estimateTalkBackOrder(parseUiHierarchyTree(xml))!.map((stops) =>
      stops.map(boundsText),
    );
    const swipes = visited.slice(1).flatMap((to, position) => {
      const from = visited[position]!;
      const window = windows.find((stops) => stops.includes(from));
      // A swipe into another window leaves the per-window order.
      if (!window || windows.some((stops) => stops !== window && stops.includes(to))) return [];
      return [{ from, to, estimated: window[(window.indexOf(from) + 1) % window.length] }];
    });
    const missing = new Set(knownMisses.map(({ from }) => from));
    const matched = swipes.filter(({ from }) => !missing.has(from));
    expect(matched.length).toBeGreaterThanOrEqual(8);
    expect(matched.map(({ estimated }) => estimated)).toEqual(matched.map(({ to }) => to));
    // A known miss that starts matching means the port changed: drop it from the fixture.
    for (const { from, to, estimated } of swipes.filter(({ from }) => missing.has(from))) {
      expect(estimated, from).not.toBe(to);
    }
  },
);

test('a container whose content sits below its next sibling is read after that sibling', () => {
  // ReorderedChildrenIterator orders a non-focusable container by the bounds of its focusable
  // content: the container spans the top of the window, but its only text sits below the sibling.
  const node = (axId: number, attrs: string, children = '') =>
    `<node ax-id="${axId}" important="true" ${attrs}>${children}</node>`;
  const xml = node(
    0,
    'class="android.widget.FrameLayout" window-type="1" bounds="[0,0][1080,2000]" window-bounds="[0,0][1080,2000]"',
    node(
      1,
      'class="android.view.ViewGroup" bounds="[0,0][1080,1000]"',
      node(2, 'class="android.widget.TextView" text="Lower" bounds="[0,800][1080,900]"'),
    ) + node(3, 'class="android.widget.TextView" text="Upper" bounds="[0,300][1080,400]"'),
  );
  const [window] = estimateTalkBackOrder(parseUiHierarchyTree(xml))!;
  expect(window!.map(({ label }) => label)).toEqual(['Upper', 'Lower']);
});

test('a capture from a helper without the screen-reader facts has no estimate', () => {
  const { xml } = talkBackFixture('permission-dialog');
  const older = xml.replaceAll(/ ax-id="\d+"/g, '');
  expect(estimateTalkBackOrder(parseUiHierarchyTree(older))).toBeUndefined();
});

test('a stop the snapshot hides is listed by its first presented descendant', () => {
  const capture = parseUiHierarchy(talkBackFixture('compose-clock').xml, undefined, {});
  const publication = androidSnapshotPublicationInput(capture);
  const evidence = readSnapshotScreenReaderOrderEvidence(publication)!;
  const labelByIndex = new Map(publication.nodes.map((node) => [node.index, node.label]));
  // The capture lists the tip popup's window first.
  const [popup, app] = evidence.windows.map(({ nodeIndexes, omittedStops }) => ({
    labels: nodeIndexes.map((index) => labelByIndex.get(index)),
    omittedStops,
  }));
  expect(popup!.labels).toContain('Dismiss');
  // TalkBack reads the clock face and the date row as label-less containers.
  expect(app!.labels.slice(0, 5)).toEqual([
    'World Clock',
    'More options',
    '5:35\u200aPM',
    'Sat, Nov 21',
    'No locations',
  ]);
  expect(app!.omittedStops).toBe(0);
});
