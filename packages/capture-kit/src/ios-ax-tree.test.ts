import { expect, test } from 'vitest';
import { flattenIosTree, resolveIosAxTreeViewport } from './ios-ax-tree.ts';

test('variant scalar attributes become the text every snapshot producer publishes', () => {
  // The system photo picker's segmented tabs report the numbers 1/0 as AXValue, and the
  // provider's JSON can carry a variant scalar in any text attribute.
  const [selected, unselected, boolean, text, empty, missing, fallback, label, identifier] =
    flattenIosTree([
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
  const [selected, unselected, explicit] = flattenIosTree([
    { type: 'Image', traits: ['Scrollable', 'Selected', 'Image'] },
    { type: 'Image', traits: ['Image'] },
    { type: 'Image', selected: true },
  ]);
  expect(selected).toHaveProperty('selected', true);
  expect(unselected?.selected).toBeUndefined();
  expect(explicit).toHaveProperty('selected', true);
});

test('raw mapping forwards observed Header traits and SDK role descriptions', () => {
  const [heading, unknown] = flattenIosTree([
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

test('a frame with a non-finite component is no rect at all, and the subrole is kept', () => {
  const [root, child] = flattenIosTree({
    type: 'Application',
    frame: { x: 0, y: 0, width: 440, height: 956 },
    children: [
      {
        type: 'TextField',
        subrole: 'AXSecureTextField',
        frame: { x: Number.NEGATIVE_INFINITY, y: 0, width: 10, height: 10 },
      },
    ],
  });
  expect(root?.rect).toEqual({ x: 0, y: 0, width: 440, height: 956 });
  expect(child?.rect).toBeUndefined();
  expect(child?.subrole).toBe('AXSecureTextField');
});

test('a root whose frame is not finite reports no viewport instead of a usable one', () => {
  expect(resolveIosAxTreeViewport([{ type: 'Application' }])).toEqual({
    kind: 'missing',
    reason: 'not-provided',
  });
  expect(
    resolveIosAxTreeViewport([
      { type: 'Application', frame: { x: 0, y: 0, width: Number.NaN, height: 956 } },
    ]),
  ).toEqual({ kind: 'missing', reason: 'invalid' });
  expect(
    resolveIosAxTreeViewport([{ type: 'Application', frame: { x: 0, y: 0, width: 0, height: 0 } }]),
  ).toEqual({ kind: 'missing', reason: 'invalid' });
});

test('without a usable root the device screen is the viewport, and a bad screen is invalid', () => {
  const rootless = [{ type: 'Application' }];
  expect(resolveIosAxTreeViewport(rootless, { width: 440, height: 956 })).toEqual({
    kind: 'reported',
    rect: { x: 0, y: 0, width: 440, height: 956 },
  });
  expect(resolveIosAxTreeViewport(rootless, { width: 0, height: 956 })).toEqual({
    kind: 'missing',
    reason: 'invalid',
  });
  expect(
    resolveIosAxTreeViewport(
      [{ type: 'Application', frame: { x: 0, y: 0, width: 320, height: 240 } }],
      { width: 440, height: 956 },
    ),
  ).toEqual({ kind: 'derived', rect: { x: 0, y: 0, width: 320, height: 240 } });
});

test('a screen box with one dimension is invalid, and a null role description is omitted', () => {
  expect(resolveIosAxTreeViewport([{ type: 'Application' }], { width: 440 })).toEqual({
    kind: 'missing',
    reason: 'invalid',
  });
  const [node] = flattenIosTree({ type: 'Button', role_description: null });
  expect(node?.roleDescription).toBeUndefined();
});
