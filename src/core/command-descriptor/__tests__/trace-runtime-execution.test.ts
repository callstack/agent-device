import { expect, test } from 'vitest';
import { commandDescriptors } from '../registry.ts';

test('diagnostic trace descriptor declares no platform execution', () => {
  const trace = commandDescriptors.find(({ name }) => name === 'trace');
  expect(trace?.platformExecution).toEqual({ kind: 'none' });
});
