import { expect, test } from 'vitest';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';

// A React Native screen: `accessibilityRole="header"` is a plain View the helper flags as a heading,
// a tab bar is a View with the role description the app set, and a label carries neither.
const ROLE_FACTS_XML = `<hierarchy>
  <node class="android.widget.FrameLayout" resource-id="root" bounds="[0,0][400,800]"
    window-index="0" window-type="1" window-layer="1" window-active="true" window-focused="true"
    window-bounds="[0,0][400,800]" visible-to-user="true" enabled="true">
    <node class="android.view.View" resource-id="inventory-header" text="Inventory" heading="true"
      bounds="[0,0][400,60]" enabled="true" visible-to-user="true" />
    <node class="android.view.View" resource-id="section-tabs" role-description="tab list"
      bounds="[0,60][400,120]" enabled="true" visible-to-user="true">
      <node class="android.view.View" resource-id="tab-fields" text="Fields" role-description="tab"
        bounds="[0,60][200,120]" clickable="true" enabled="true" visible-to-user="true" />
    </node>
    <node class="android.widget.TextView" resource-id="plain-label" text="Wi-Fi"
      bounds="[0,120][400,180]" enabled="true" visible-to-user="true" />
  </node>
</hierarchy>`;

function nodesById(raw: boolean, interactiveOnly = false) {
  const { nodes } = buildUiHierarchySnapshot(parseUiHierarchyTree(ROLE_FACTS_XML), undefined, {
    raw,
    interactiveOnly,
  });
  return (identifier: string) => nodes.find((node) => node.identifier === identifier);
}

test.each([
  { raw: false, interactiveOnly: false },
  { raw: true, interactiveOnly: false },
  { raw: true, interactiveOnly: true },
])(
  'the heading flag and the role description reach snapshot nodes (raw=$raw, -i=$interactiveOnly)',
  ({ raw, interactiveOnly }) => {
    const byId = nodesById(raw, interactiveOnly);
    expect(byId('inventory-header')?.heading).toBe(true);
    expect(byId('section-tabs')?.roleDescription).toBe('tab list');
    expect(byId('tab-fields')?.roleDescription).toBe('tab');
  },
);

test('a node without either fact carries neither key once serialized', () => {
  const byId = nodesById(false);
  const label = JSON.parse(JSON.stringify(byId('plain-label')));
  expect(label).not.toHaveProperty('heading');
  expect(label).not.toHaveProperty('roleDescription');
  // A heading is not a role description and a role description is not a heading.
  expect(JSON.parse(JSON.stringify(byId('inventory-header')))).not.toHaveProperty(
    'roleDescription',
  );
  expect(JSON.parse(JSON.stringify(byId('tab-fields')))).not.toHaveProperty('heading');
});

test('the class stays the type: a role description refines nothing on its own', () => {
  const byId = nodesById(false);
  expect(byId('tab-fields')?.type).toBe('android.view.View');
  expect(byId('inventory-header')?.label).toBe('Inventory');
});
