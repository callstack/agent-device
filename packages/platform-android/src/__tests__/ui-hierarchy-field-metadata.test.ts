import { expect, test } from 'vitest';
import { buildUiHierarchySnapshot, parseUiHierarchyTree } from '../ui-hierarchy.ts';

test.each([false, true])(
  'editable field metadata survives snapshot presentation (raw=%s)',
  (raw) => {
    const tree = parseUiHierarchyTree(`<hierarchy><node class="android.widget.EditText"
    resource-id="field" text="" bounds="[0,0][200,100]" visible-to-user="true"
    editable="true" password="true" hint-showing="false" selection-start="0" selection-end="0"
    focusable="true" focused="true" /></hierarchy>`);
    const { nodes } = buildUiHierarchySnapshot(tree, undefined, { raw });
    expect(nodes.find((node) => node.identifier === 'field')).toMatchObject({
      value: '',
      editable: true,
      password: true,
      hintShowing: false,
      selectionStart: 0,
      selectionEnd: 0,
    });
  },
);

test('selection offsets survive on a read-only selectable node (independent of editable)', () => {
  const tree = parseUiHierarchyTree(`<hierarchy><node class="android.widget.TextView"
    resource-id="field" text="Read-only text" bounds="[0,0][200,100]" visible-to-user="true"
    editable="false" selection-start="2" selection-end="5" /></hierarchy>`);
  const { nodes } = buildUiHierarchySnapshot(tree, undefined, { raw: true });
  expect(nodes.find((node) => node.identifier === 'field')).toMatchObject({
    editable: false,
    selectionStart: 2,
    selectionEnd: 5,
  });
});

test('missing native field metadata remains unknown instead of becoming false or zero', () => {
  const tree = parseUiHierarchyTree(`<hierarchy><node class="android.widget.EditText"
    resource-id="field" bounds="[0,0][200,100]" focusable="true" /></hierarchy>`);
  const { nodes } = buildUiHierarchySnapshot(tree, undefined, { raw: true });
  const field = nodes.find((node) => node.identifier === 'field');
  expect(field).toBeDefined();
  expect(field?.value).toBeUndefined();
  expect(field?.editable).toBeUndefined();
  expect(field?.password).toBeUndefined();
  expect(field?.hintShowing).toBeUndefined();
  expect(field?.selectionStart).toBeUndefined();
  expect(field?.selectionEnd).toBeUndefined();
});
