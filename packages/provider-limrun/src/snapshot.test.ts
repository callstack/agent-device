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
