import { expect, test } from 'vitest';
import { parseUiHierarchyTree } from '../ui-hierarchy.ts';
import { buildUiHierarchySnapshot } from '../ui-hierarchy-builder.ts';

test('builder clips each Android node to its owning window before regular presentation', () => {
  // Planted red on the pre-#1968 builder: the dialog descendant inherited the largest application
  // viewport instead of the dialog window and kept a positive rectangle outside that window.
  const tree = parseUiHierarchyTree(`<hierarchy>
    <node class="android.widget.FrameLayout" bounds="[0,0][400,800]"
      window-bounds="[0,0][400,800]" window-index="0" window-type="1"
      window-layer="1" window-active="true" window-focused="true" visible-to-user="true">
      <node class="android.widget.Button" text="Main action" bounds="[20,20][180,80]"
        clickable="true" visible-to-user="true" />
    </node>
    <node class="android.widget.FrameLayout" bounds="[100,100][300,300]"
      window-bounds="[100,100][300,300]" window-index="1" window-type="2"
      window-layer="2" window-active="true" window-focused="true" visible-to-user="true">
      <node class="android.widget.Button" text="Outside dialog" bounds="[120,320][180,380]"
        clickable="true" visible-to-user="true" />
    </node>
  </hierarchy>`);

  const { nodes } = buildUiHierarchySnapshot(tree, undefined, {});
  expect(nodes.find((node) => node.label === 'Outside dialog')).toMatchObject({
    rect: { x: 120, y: 320, width: 0, height: 0 },
    hittable: undefined,
  });
});
