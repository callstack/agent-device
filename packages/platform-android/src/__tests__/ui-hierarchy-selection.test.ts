import { expect, test } from 'vitest';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';

// The bottom-tab shape from #2462: sibling tabs whose type, label, and identifier are all
// present and differ only in which one the app marked selected.
function tabBarXml(homeSelected: boolean, localSelected: boolean): string {
  return `<hierarchy>
    <node class="android.widget.FrameLayout" resource-id="tab-bar" bounds="[0,724][400,800]"
      window-index="0" window-type="1" window-layer="1" window-active="true" window-focused="true"
      window-bounds="[0,0][400,800]" visible-to-user="true" enabled="true">
      <node class="android.view.View" resource-id="home-tab" content-desc="Home"
        bounds="[0,724][200,800]" clickable="true" enabled="true" visible-to-user="true"
        selected="${homeSelected}" />
      <node class="android.view.View" resource-id="local-tab" content-desc="Local"
        bounds="[200,724][400,800]" clickable="true" enabled="true" visible-to-user="true"
        selected="${localSelected}" />
    </node>
  </hierarchy>`;
}

// A helper older than the `selected` attribute, or any producer that omits it.
const UNREPORTED_SELECTION_XML =
  '<hierarchy><node class="android.view.View" resource-id="legacy-tab" content-desc="Home"' +
  ' bounds="[0,724][200,800]" clickable="true" enabled="true" visible-to-user="true" /></hierarchy>';

function tabNodes(raw: boolean, interactiveOnly = false) {
  const { nodes } = buildUiHierarchySnapshot(
    parseUiHierarchyTree(tabBarXml(true, false)),
    undefined,
    { raw, interactiveOnly },
  );
  return {
    home: nodes.find((node) => node.identifier === 'home-tab'),
    local: nodes.find((node) => node.identifier === 'local-tab'),
  };
}

function unreportedSelectionNode() {
  return buildUiHierarchySnapshot(parseUiHierarchyTree(UNREPORTED_SELECTION_XML), undefined, {
    raw: false,
  }).nodes.find((node) => node.identifier === 'legacy-tab');
}

test.each([
  { raw: false, interactiveOnly: false },
  { raw: false, interactiveOnly: true },
  { raw: true, interactiveOnly: false },
  { raw: true, interactiveOnly: true },
])(
  'accessibility selection reaches snapshot nodes in every projection (raw=$raw, -i=$interactiveOnly)',
  ({ raw, interactiveOnly }) => {
    const { home, local } = tabNodes(raw, interactiveOnly);
    expect(home?.selected).toBe(true);
    expect(local?.selected).toBe(false);
  },
);

test('attrs answer explicit false where an unreported selection answers nothing', () => {
  // Serialized, because that is the answer an agent reads: an unavailable fact drops the key
  // while JSON encodes an observed `false`.
  const serializedLocal = JSON.parse(JSON.stringify(tabNodes(false).local));
  const serializedLegacy = JSON.parse(JSON.stringify(unreportedSelectionNode()));
  expect(serializedLocal.selected).toBe(false);
  expect(serializedLegacy).not.toHaveProperty('selected');
});

test.each([
  { homeSelected: true, localSelected: false, selectedTabs: ['home-tab'] },
  { homeSelected: false, localSelected: true, selectedTabs: ['local-tab'] },
])(
  'selection, not the label, is what names the active tab ($selectedTabs)',
  ({ homeSelected, localSelected, selectedTabs }) => {
    const { nodes } = buildUiHierarchySnapshot(
      parseUiHierarchyTree(tabBarXml(homeSelected, localSelected)),
      undefined,
      { raw: false },
    );
    // Both tabs stay addressable by label, so selection is the only thing that can tell them apart.
    expect(nodes.filter((node) => node.selected === true).map((node) => node.identifier)).toEqual(
      selectedTabs,
    );
    expect(nodes.filter((node) => node.label === 'Home' || node.label === 'Local')).toHaveLength(2);
  },
);

test('unreported selection stays unknown instead of becoming false', () => {
  const node = unreportedSelectionNode();
  expect(node).toBeDefined();
  expect(node?.selected).toBeUndefined();
});
