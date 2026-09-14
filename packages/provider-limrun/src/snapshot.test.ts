import { expect, test } from 'vitest';
import { toIosSelector } from './snapshot.ts';

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
