import { expect, test } from 'vitest';
import { createMaestroExecutionContext } from '../engine-context.ts';

test('resolves transitive scoped variables to their final value', () => {
  const context = createMaestroExecutionContext();
  const leave = context.enter({
    TARGET: '${NEXT}',
    NEXT: '${FINAL}',
    FINAL: 'Done',
  });

  expect(context.resolve('${TARGET}')).toBe('Done');
  expect(context.expandedVariables).toEqual({ TARGET: 'Done' });
  leave();
});

test('retains expanded values after nested scopes unwind', () => {
  const context = createMaestroExecutionContext();
  const rootLeave = context.enter({ SECRET: 'nested-scope-secret' });
  const nestedLeave = context.enter({ TARGET: '${SECRET}' });

  expect(context.resolve('${TARGET}')).toBe('nested-scope-secret');
  nestedLeave();
  rootLeave();

  expect(context.expandedVariables).toEqual({
    TARGET: 'nested-scope-secret',
  });
});

test('preserves cyclic references instead of recursing indefinitely', () => {
  const context = createMaestroExecutionContext({ FIRST: '${SECOND}', SECOND: '${FIRST}' });

  expect(context.resolve('${FIRST}')).toBe('${FIRST}');
});
