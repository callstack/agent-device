import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshotState } from '../../../daemon/snapshot-state.ts';
import { parseUiHierarchy } from './ui-hierarchy-fixtures.ts';

// Android's scope leg of the golden table (#1832 C2). Android resolves `--scope` exactly once,
// over the PRESENTED nodes of the requested projection, inside its projection; the daemon never
// reapplies scope after the wire. Pinned here: the projection agrees with
// contracts/fixtures/snapshot-scope-policy.json, scope resolves after membership, ancestor
// context above the scope root still shapes membership inside it, --depth is scope-relative, and
// a scoped Android snapshot survives buildSnapshotState untouched.

type ScopePolicyCase = {
  name: string;
  scope: string;
  nodes: Array<{
    depth: number;
    type?: string;
    label?: string;
    value?: string;
    identifier?: string;
    presented?: boolean;
  }>;
  expectedSubtreeIndexes: number[];
};

const TABLE_PATH = path.resolve(
  import.meta.dirname,
  '../../../../contracts/fixtures/snapshot-scope-policy.json',
);

/**
 * Renders the flat golden list as helper XML. Fixture position rides in the bounds' x origin so
 * the assertion never depends on which text field carried the match. Android reads
 * `label = text || content-desc` and `value = text`, so a fixture value goes to `text` and a
 * label with no value to `content-desc`. Most cases render as `TextView` so regular membership
 * keeps every node. Contribution cases declare their Android type and expected membership so the
 * same table also exercises scope selection after membership.
 */
function scopePolicyXml(nodes: ScopePolicyCase['nodes']): string {
  const lines: string[] = ['<hierarchy>'];
  const open: number[] = [];
  nodes.forEach((node, index) => {
    while (open.length > node.depth) {
      open.pop();
      lines.push('</node>');
    }
    const attrs = [
      `class="${node.type === 'ViewGroup' ? 'android.view.ViewGroup' : `android.widget.${node.type ?? 'TextView'}`}"`,
      `bounds="[${index},0][${index + 1},1]"`,
      `visible-to-user="true"`,
      node.type === 'Button' ? `clickable="true"` : '',
      node.value !== undefined ? `text="${node.value}"` : '',
      node.label !== undefined && node.value === undefined ? `content-desc="${node.label}"` : '',
      node.identifier !== undefined ? `resource-id="${node.identifier}"` : '',
    ].filter(Boolean);
    lines.push(`<node ${attrs.join(' ')}>`);
    open.push(index);
  });
  while (open.length > 0) {
    open.pop();
    lines.push('</node>');
  }
  lines.push('</hierarchy>');
  return lines.join('\n');
}

test('the Android projection agrees with every golden scope-policy table case', () => {
  const cases = JSON.parse(fs.readFileSync(TABLE_PATH, 'utf8')) as ScopePolicyCase[];
  assert.ok(cases.length > 0);
  for (const fixture of cases) {
    const hasMembershipCase = fixture.nodes.some((node) => node.presented !== undefined);
    const projections = hasMembershipCase ? [{ interactiveOnly: true }] : [{ raw: true }, {}];
    for (const projection of projections) {
      const result = parseUiHierarchy(scopePolicyXml(fixture.nodes), undefined, {
        ...projection,
        scope: fixture.scope,
      });
      const expected = fixture.expectedSubtreeIndexes.filter(
        (index) => fixture.nodes[index]?.presented !== false,
      );
      assert.deepEqual(
        result.nodes.map((node) => node.rect?.x),
        expected,
        `${fixture.name} (${JSON.stringify(projection)})`,
      );
      if (result.nodes.length > 0) assert.equal(result.nodes[0]?.depth, 0, fixture.name);
    }
  }
});

test('a scoped Android snapshot is not re-scoped after the wire', () => {
  // The projection already re-rooted at the panel and handed the daemon a real scoped tree: a root
  // at depth 0 with its children below. A second pass with the same scope text would re-match
  // inside it (or empty it, since the panel node itself may have been dropped by membership).
  const nodes = parseUiHierarchy(
    `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.widget.ScrollView" resource-id="panel" bounds="[0,0][390,400]" visible-to-user="true">
      <node class="android.widget.Button" text="Save" bounds="[0,0][390,60]" clickable="true" visible-to-user="true"/>
      <node class="android.widget.Button" text="Cancel" bounds="[0,60][390,120]" clickable="true" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`,
    undefined,
    { interactiveOnly: true, scope: 'panel' },
  ).nodes;
  assert.deepEqual(
    nodes.map((node) => [node.depth, node.identifier ?? node.label]),
    [
      [0, 'panel'],
      [1, 'Save'],
      [1, 'Cancel'],
    ],
    'projection output: scoped root at depth 0, its children below it',
  );

  const state = buildSnapshotState({ nodes, backend: 'android' }, { snapshotScope: 'panel' });
  assert.deepEqual(
    state.nodes.map((node) => node.label ?? node.identifier),
    ['panel', 'Save', 'Cancel'],
  );
});

test('an Android scope with no match yields an empty snapshot in every projection', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.widget.Button" text="Search" bounds="[0,0][390,60]" clickable="true" visible-to-user="true"/>
  </node>
</hierarchy>`;
  for (const options of [{}, { raw: true }, { interactiveOnly: true }]) {
    const result = parseUiHierarchy(xml, undefined, { ...options, scope: 'zzzz-no-match-token' });
    assert.deepEqual(result.nodes, [], JSON.stringify(options));
  }
});

test('scope keeps the ancestor context above the scope root (scoped -i ⊆ unscoped -i)', () => {
  // The Compose text proxy inside a clickable row survives -i only because an ANCESTOR is a target.
  // Re-rooting the walk at the cell used to lose that fact and empty the scoped snapshot.
  const xml = `<hierarchy>
  <node class="android.widget.LinearLayout" bounds="[0,0][390,80]" clickable="true" visible-to-user="true">
    <node class="android.view.ViewGroup" resource-id="cell" bounds="[0,0][390,80]" visible-to-user="true">
      <node class="android.widget.TextView" text="Cell text" bounds="[0,0][390,80]" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`;
  const scoped = parseUiHierarchy(xml, undefined, { interactiveOnly: true, scope: 'cell' });
  assert.deepEqual(
    scoped.nodes.map((node) => [node.depth, node.identifier ?? node.label]),
    [
      [0, 'cell'],
      [1, 'Cell text'],
    ],
  );
});

test('--depth under --scope counts from the scope root', () => {
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.view.ViewGroup" resource-id="panel" bounds="[0,0][390,400]" visible-to-user="true">
      <node class="android.widget.Button" text="Level 1" bounds="[0,0][390,60]" clickable="true" visible-to-user="true">
        <node class="android.widget.TextView" text="Level 2" bounds="[0,0][390,60]" visible-to-user="true"/>
      </node>
    </node>
  </node>
</hierarchy>`;
  const scoped = parseUiHierarchy(xml, undefined, { raw: true, scope: 'panel', depth: 1 });
  assert.deepEqual(
    scoped.nodes.map((node) => [node.depth, node.parentIndex, node.identifier ?? node.label]),
    [
      [0, undefined, 'panel'],
      [1, 0, 'Level 1'],
    ],
  );
});

test('a matched container membership drops still scopes to its presented content (#1846 review P1)', () => {
  // `id/panel` is a structural ViewGroup: -i drops the container itself but keeps the button inside
  // it. Requiring a presented ROOT would answer "no nodes" to a scope whose content plainly exists.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.view.ViewGroup" resource-id="panel" bounds="[0,0][390,400]" visible-to-user="true">
      <node class="android.widget.Button" text="Save" bounds="[0,0][390,60]" clickable="true" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`;

  const scoped = parseUiHierarchy(xml, undefined, { interactiveOnly: true, scope: 'panel' });
  assert.deepEqual(
    scoped.nodes.map((node) => [node.depth, node.parentIndex, node.label]),
    [[0, undefined, 'Save']],
    "the retained child is re-rooted at depth 0, not left at the dropped container's depth",
  );
  assert.deepEqual(
    parseUiHierarchy(xml, undefined, { interactiveOnly: true }).nodes.map((node) => node.label),
    ['Save'],
    'scoped -i stays a subset of unscoped -i',
  );

  // The depth the response prints is the depth --depth filters on: a node shown at depth 0 cannot
  // vanish at --depth 0.
  assert.deepEqual(
    parseUiHierarchy(xml, undefined, { interactiveOnly: true, scope: 'panel', depth: 0 }).nodes.map(
      (node) => node.label,
    ),
    ['Save'],
  );
});

test('a match whose subtree presents nothing is skipped for the next candidate', () => {
  // The decorative heading matches "settings" first in document order but contributes no -i node;
  // the scroll panel below it does.
  const xml = `<hierarchy>
  <node class="android.widget.FrameLayout" bounds="[0,0][390,844]" visible-to-user="true">
    <node class="android.widget.TextView" text="Settings" bounds="[0,0][390,60]" visible-to-user="true"/>
    <node class="android.widget.ScrollView" resource-id="settings-panel" bounds="[0,60][390,400]" visible-to-user="true">
      <node class="android.widget.Button" text="Wi-Fi" bounds="[0,60][390,120]" clickable="true" visible-to-user="true"/>
    </node>
  </node>
</hierarchy>`;
  assert.deepEqual(
    parseUiHierarchy(xml, undefined, { interactiveOnly: true, scope: 'settings' }).nodes.map(
      (node) => [node.depth, node.identifier ?? node.label],
    ),
    [
      [0, 'settings-panel'],
      [1, 'Wi-Fi'],
    ],
  );
  // Regular presents the heading, so document order picks it — and it is the whole snapshot.
  assert.deepEqual(
    parseUiHierarchy(xml, undefined, { scope: 'settings' }).nodes.map((node) => node.label),
    ['Settings'],
  );
});
