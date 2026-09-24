import { expect, test } from 'vitest';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';

// A form: an empty field shows its hint (and reports the hint as its text), a filled field no longer
// shows it but still has one, and a label has none.
const PLACEHOLDER_XML = `<hierarchy>
  <node class="android.widget.FrameLayout" resource-id="root" bounds="[0,0][400,800]"
    window-index="0" window-type="1" window-layer="1" window-active="true" window-focused="true"
    window-bounds="[0,0][400,800]" visible-to-user="true" enabled="true">
    <node class="android.widget.TextView" resource-id="name-label" text="Name"
      bounds="[0,0][400,60]" enabled="true" visible-to-user="true" />
    <node class="android.widget.EditText" resource-id="name-input" text="Key echo" hint="Key echo"
      hint-showing="true" editable="true" bounds="[0,60][400,120]" clickable="true" focusable="true"
      enabled="true" visible-to-user="true" />
    <node class="android.widget.EditText" resource-id="email-input" text="ada@example.com"
      hint="Email address" hint-showing="false" editable="true" bounds="[0,120][400,180]"
      clickable="true" focusable="true" enabled="true" visible-to-user="true" />
  </node>
</hierarchy>`;

function nodesById(raw: boolean, interactiveOnly = false) {
  const { nodes } = buildUiHierarchySnapshot(parseUiHierarchyTree(PLACEHOLDER_XML), undefined, {
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
  'the placeholder reaches snapshot nodes whether or not the field shows it (raw=$raw, -i=$interactiveOnly)',
  ({ raw, interactiveOnly }) => {
    const byId = nodesById(raw, interactiveOnly);
    expect(byId('name-input')?.placeholder).toBe('Key echo');
    expect(byId('name-input')?.hintShowing).toBe(true);
    expect(byId('email-input')?.placeholder).toBe('Email address');
    expect(byId('email-input')?.hintShowing).toBe(false);
  },
);

test('the value stays what the platform reported: the hint while showing, the text once filled', () => {
  const byId = nodesById(false);
  expect(byId('name-input')?.value).toBe('Key echo');
  expect(byId('email-input')?.value).toBe('ada@example.com');
});

test('a node without a hint carries no placeholder key once serialized', () => {
  const byId = nodesById(false);
  expect(JSON.parse(JSON.stringify(byId('name-label')))).not.toHaveProperty('placeholder');
});
