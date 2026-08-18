import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshotState } from '../../../daemon/handlers/snapshot-capture.ts';
import { parseUiHierarchy } from '../ui-hierarchy.ts';

// Android's scope leg of the golden table (#1832 C2). Android resolves `--scope` exactly once,
// inside its projection; the daemon's post-wire pass skips the android backend. Both facts are
// pinned here: the projection agrees with contracts/fixtures/snapshot-scope-policy.json, and a
// scoped Android snapshot survives buildSnapshotState untouched.

type ScopePolicyCase = {
  name: string;
  scope: string;
  nodes: Array<{ depth: number; label?: string; value?: string; identifier?: string }>;
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
 * label with no value to `content-desc`.
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
      `class="android.view.View"`,
      `bounds="[${index},0][${index + 1},1]"`,
      `visible-to-user="true"`,
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
    const result = parseUiHierarchy(scopePolicyXml(fixture.nodes), undefined, {
      raw: true,
      scope: fixture.scope,
    });
    assert.deepEqual(
      result.nodes.map((node) => node.rect?.x),
      fixture.expectedSubtreeIndexes,
      fixture.name,
    );
    if (result.nodes.length > 0) assert.equal(result.nodes[0]?.depth, 0, fixture.name);
  }
});

test('a scoped Android snapshot is not re-scoped after the wire', () => {
  // The projection already re-rooted at "Panel"; a post-wire pass with the same scope would look
  // for "Panel" again inside a tree whose root is the panel's first CHILD if membership dropped the
  // container. Android's presented nodes must pass through buildSnapshotState unchanged.
  const nodes = [
    { index: 0, depth: 0, type: 'android.widget.Button', label: 'Save', hittable: true },
    { index: 1, depth: 0, type: 'android.widget.Button', label: 'Cancel', hittable: true },
  ];
  const state = buildSnapshotState({ nodes, backend: 'android' }, { snapshotScope: 'Panel' });
  assert.deepEqual(
    state.nodes.map((node) => node.label),
    ['Save', 'Cancel'],
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
