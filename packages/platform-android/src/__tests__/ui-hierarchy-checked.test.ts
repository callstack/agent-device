import { expect, test } from 'vitest';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';

// A settings row: a switch the helper reports as checkable beside a label that is not. The helper
// writes `checked` only on the checkable node, with both answers.
function togglesXml(wifiChecked: boolean): string {
  return `<hierarchy>
    <node class="android.widget.LinearLayout" resource-id="toggles" bounds="[0,0][400,200]"
      window-index="0" window-type="1" window-layer="1" window-active="true" window-focused="true"
      window-bounds="[0,0][400,800]" visible-to-user="true" enabled="true">
      <node class="android.widget.TextView" resource-id="wifi-label" text="Wi-Fi"
        bounds="[0,0][200,100]" enabled="true" visible-to-user="true" />
      <node class="android.widget.Switch" resource-id="wifi-switch" content-desc="Wi-Fi switch"
        bounds="[200,0][400,100]" clickable="true" enabled="true" visible-to-user="true"
        checked="${wifiChecked}" />
      <node class="android.widget.RadioButton" resource-id="size-small" text="Small"
        bounds="[0,100][400,200]" clickable="true" enabled="true" visible-to-user="true"
        checked="false" />
    </node>
  </hierarchy>`;
}

// A helper older than the `checked` attribute, or a switch it did not report as checkable.
const UNREPORTED_CHECKED_XML =
  '<hierarchy><node class="android.widget.Switch" resource-id="legacy-switch" content-desc="Wi-Fi"' +
  ' bounds="[200,0][400,100]" clickable="true" enabled="true" visible-to-user="true" /></hierarchy>';

function toggleNodes(raw: boolean, interactiveOnly = false, wifiChecked = true) {
  const { nodes } = buildUiHierarchySnapshot(
    parseUiHierarchyTree(togglesXml(wifiChecked)),
    undefined,
    { raw, interactiveOnly },
  );
  const byId = (identifier: string) => nodes.find((node) => node.identifier === identifier);
  return { label: byId('wifi-label'), wifi: byId('wifi-switch'), small: byId('size-small') };
}

test.each([
  { raw: false, interactiveOnly: false },
  { raw: false, interactiveOnly: true },
  { raw: true, interactiveOnly: false },
  { raw: true, interactiveOnly: true },
])(
  'checked state reaches snapshot nodes in every projection (raw=$raw, -i=$interactiveOnly)',
  ({ raw, interactiveOnly }) => {
    const { wifi, small } = toggleNodes(raw, interactiveOnly);
    expect(wifi?.checked).toBe(true);
    expect(small?.checked).toBe(false);
  },
);

test.each([true, false])('the switch answers the state the helper observed (%s)', (wifiChecked) => {
  expect(toggleNodes(false, false, wifiChecked).wifi?.checked).toBe(wifiChecked);
});

test('attrs answer explicit false where a node that cannot be checked answers nothing', () => {
  // Serialized, because that is the answer an agent reads: an unavailable fact drops the key
  // while JSON encodes an observed `false`.
  const { label, small } = toggleNodes(false);
  expect(JSON.parse(JSON.stringify(small)).checked).toBe(false);
  expect(JSON.parse(JSON.stringify(label))).not.toHaveProperty('checked');
});

test('an unreported checked state stays unknown instead of becoming false', () => {
  const node = buildUiHierarchySnapshot(parseUiHierarchyTree(UNREPORTED_CHECKED_XML), undefined, {
    raw: false,
  }).nodes.find((node) => node.identifier === 'legacy-switch');
  expect(node).toBeDefined();
  expect(node?.checked).toBeUndefined();
});
