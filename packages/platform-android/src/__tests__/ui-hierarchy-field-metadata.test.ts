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
    resource-id="field" text="Read-only text" content-desc="Read-only announcement"
    hint="Label prompt" bounds="[0,0][200,100]" visible-to-user="true"
    editable="false" selection-start="2" selection-end="5" /></hierarchy>`);
  const { nodes } = buildUiHierarchySnapshot(tree, undefined, { raw: true });
  expect(nodes.find((node) => node.identifier === 'field')?.value).toBeUndefined();
  expect(nodes.find((node) => node.identifier === 'field')).toMatchObject({
    label: 'Read-only text',
    contentDescription: 'Read-only announcement',
    placeholder: 'Label prompt',
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
  const serialized = JSON.parse(JSON.stringify(field));
  expect(serialized).not.toHaveProperty('value');
  expect(serialized).not.toHaveProperty('editable');
  expect(serialized).not.toHaveProperty('password');
  expect(serialized).not.toHaveProperty('hintShowing');
  expect(serialized).not.toHaveProperty('selectionStart');
  expect(serialized).not.toHaveProperty('selectionEnd');
});

test('ADB parses native field evidence and hint state before assigning values', () => {
  const tree = parseUiHierarchyTree(`<hierarchy>
    <node class="com.example.CustomInput" text="Prompt" editable="true" hint="Prompt" hint-showing="true" />
    <node class="com.example.CustomInput" text="Prompt" editable="true" hint="Prompt" hint-showing="false" />
    <node class="com.example.SecureInput" text="••••" password="true" hint-showing="unknown" />
    <node class="android.widget.TextView" text="Static label" editable="false" />
  </hierarchy>`);
  const { nodes } = buildUiHierarchySnapshot(tree, undefined, { raw: true });
  expect(
    nodes.map(({ value, placeholder, hintShowing }) => [value, placeholder, hintShowing]),
  ).toEqual([
    ['', 'Prompt', true],
    ['Prompt', 'Prompt', false],
    ['••••', undefined, false],
    [undefined, undefined, undefined],
  ]);
});
