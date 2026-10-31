import { expect, test } from 'vitest';
import { flattenAxeTree, readAxeTreeViewport } from './ios-axe-tree.ts';

test('variant scalar attributes become the text every snapshot producer publishes', () => {
  // The system photo picker's segmented tabs report the numbers 1/0 as AXValue, and the
  // provider's JSON can carry a variant scalar in any text attribute.
  const [selected, unselected, boolean, text, empty, missing, fallback, label, identifier] =
    flattenAxeTree([
      { type: 'RadioButton', AXLabel: 'Photos', AXValue: 1 },
      { type: 'RadioButton', AXLabel: 'Collections', AXValue: 0 },
      { type: 'Switch', value: true },
      { type: 'TextField', AXValue: 'qa@example.com' },
      { type: 'TextField', value: '' },
      { type: 'TextField', AXValue: null },
      { type: 'TextField', value: '', AXValue: 1 },
      { type: 'Other', label: 42, AXLabel: 'fallback' },
      { type: 'Other', identifier: true, AXUniqueId: 'fallback' },
    ]);
  expect([selected?.value, unselected?.value, boolean?.value]).toEqual(['1', '0', 'true']);
  expect(text?.value).toBe('qa@example.com');
  expect([empty?.value, missing?.value]).toEqual([undefined, undefined]);
  expect(fallback?.value).toBe('1');
  expect([label?.label, identifier?.identifier]).toEqual(['42', 'true']);
});

test('the Selected trait publishes selection in the shape the Apple tree uses', () => {
  const [selected, unselected, explicit] = flattenAxeTree([
    { type: 'Image', traits: ['Scrollable', 'Selected', 'Image'] },
    { type: 'Image', traits: ['Image'] },
    { type: 'Image', selected: true },
  ]);
  expect(selected).toHaveProperty('selected', true);
  expect(unselected?.selected).toBeUndefined();
  expect(explicit).toHaveProperty('selected', true);
});

test('the raw mapping forwards observed Header traits and role descriptions', () => {
  const [heading, unknown] = flattenAxeTree([
    { type: 'Heading', traits: ['Scrollable', 'Header'], role_description: 'heading' },
    { type: 'TextField', traits: ['TextEntry'] },
  ]);
  expect(heading).toMatchObject({ heading: true, roleDescription: 'heading' });
  expect(unknown!.heading).toBeUndefined();
  expect(unknown!.roleDescription).toBeUndefined();
  expect([unknown!.checked, unknown!.password, unknown!.editable]).toEqual([
    undefined,
    undefined,
    undefined,
  ]);
});

test('the application root reports the screen box as derived evidence', () => {
  expect(
    readAxeTreeViewport([
      { type: 'Application', frame: { x: 0, y: 0, width: 402, height: 874 }, children: [] },
    ]),
  ).toEqual({ kind: 'derived', rect: { x: 0, y: 0, width: 402, height: 874 } });
  expect(
    readAxeTreeViewport({ elementType: 'Window', rect: { x: 0, y: 0, width: 320, height: 640 } }),
  ).toEqual({ kind: 'derived', rect: { x: 0, y: 0, width: 320, height: 640 } });
});

test('a root without a usable frame keeps the reason, and a tree with no root answers nothing', () => {
  expect(
    readAxeTreeViewport([{ type: 'Application', frame: { x: 0, y: 0, width: 0, height: 874 } }]),
  ).toEqual({ kind: 'missing', reason: 'invalid' });
  expect(readAxeTreeViewport([{ type: 'Application' }])).toEqual({
    kind: 'missing',
    reason: 'not-provided',
  });
  expect(
    readAxeTreeViewport([{ type: 'Button', frame: { x: 0, y: 0, width: 10, height: 10 } }]),
  ).toBe(undefined);
});

test('children, nodes and elements all nest, with depth and parent', () => {
  const nodes = flattenAxeTree({
    type: 'Application',
    children: [{ type: 'Other', nodes: [{ type: 'Button', AXLabel: 'OK' }] }],
    elements: [{ type: 'Ignored' }],
  });
  expect(nodes.map((node) => [node.type, node.depth, node.parentIndex])).toEqual([
    ['Application', 0, undefined],
    ['Other', 1, 0],
    ['Button', 2, 1],
  ]);
});
