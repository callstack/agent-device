import { expect, test } from 'vitest';
import { viewportRuntimeOperationFacts } from './viewport-runtime.ts';

test('builds the exact viewport operation fact catalog', () => {
  const setViewport = { available: true } as const;
  expect(viewportRuntimeOperationFacts({ setViewport })).toEqual({ setViewport });
});
