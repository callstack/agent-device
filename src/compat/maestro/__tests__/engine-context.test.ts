import { expect, test, vi } from 'vitest';
import { createMaestroExecutionContext } from '../engine-context.ts';
import type { MaestroRuntimePort } from '../engine-types.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { executeMaestroProgram } from './runtime-port-fixtures.ts';

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

test('rejects cyclic references instead of recursing indefinitely', () => {
  const context = createMaestroExecutionContext({ FIRST: '${SECOND}', SECOND: '${FIRST}' });

  expect(() => context.resolve('${FIRST}')).toThrow(/cyclic reference/i);
});

test.each(['${MISSING}', '${1 + 1}'])(
  'fails loudly with source context for unsupported interpolation %s',
  async (value) => {
    const port: MaestroRuntimePort = {
      execute: vi.fn(async (request) => {
        request.invalidateObservation();
        return {};
      }),
      observe: vi.fn(async ({ generation }) => ({ generation, matched: true })),
    };
    const program = parseMaestroProgram(`---\n- inputText: "${value}"\n`, {
      sourcePath: '/flows/interpolation.yaml',
    });

    await expect(executeMaestroProgram(program, port)).rejects.toThrow(
      /Maestro (variable|interpolation).*\/flows\/interpolation\.yaml:line 2/i,
    );
    expect(port.execute).not.toHaveBeenCalled();
  },
);
