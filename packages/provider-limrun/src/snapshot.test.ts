import { expect, test } from 'vitest';
import { flattenIosTree, toIosSelector } from './snapshot.ts';

test('agent-device selector keys become the accessibility keys the iOS instance matches', () => {
  expect(toIosSelector({ key: 'id', value: 'email-field' })).toEqual({
    AXUniqueId: 'email-field',
  });
  expect(toIosSelector({ key: 'value', value: 'qa@example.com' })).toEqual({
    AXValue: 'qa@example.com',
  });
  expect(toIosSelector({ key: 'label', value: 'Email' })).toEqual({ AXLabel: 'Email' });
});

test('visible text targets the provider label field, which is where the tree exposes it', () => {
  expect(toIosSelector({ key: 'text', value: 'Sign In' })).toEqual({ AXLabel: 'Sign In' });
});

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

test('Limrun raw mapping forwards observed Header traits and SDK role descriptions', () => {
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
