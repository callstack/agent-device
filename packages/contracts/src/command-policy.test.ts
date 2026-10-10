import { expect, test } from 'vitest';
import { localCommandPolicy, restrictedCommandPolicy } from './command-policy.ts';

test('command policy presets expose local and restricted defaults', () => {
  expect(localCommandPolicy().allowLocalInputPaths).toBe(true);
  expect(localCommandPolicy().allowLocalOutputPaths).toBe(true);
  expect(restrictedCommandPolicy().allowLocalInputPaths).toBe(false);
  expect(restrictedCommandPolicy({ allowLocalInputPaths: true }).allowLocalInputPaths).toBe(true);
});
