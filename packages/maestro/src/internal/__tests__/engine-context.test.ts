import { expect, test, vi } from 'vitest';
import { maestroTestFailure } from '../compatibility-errors.ts';
import { createMaestroExecutionContext } from '../engine-context.ts';
import type { MaestroRuntimePort } from '../engine-types.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { executeMaestroProgram } from './runtime-port-fixtures.ts';

test('resolves transitive scoped variables', () => {
  const context = createMaestroExecutionContext();
  const leave = context.enter({
    TARGET: '${NEXT}',
    NEXT: '${FINAL}',
    FINAL: 'Done',
  });

  expect(context.resolve('${TARGET}')).toBe('Done');
  leave();
});

test('keeps nested scopes valid until they unwind', () => {
  const context = createMaestroExecutionContext();
  const rootLeave = context.enter({ SECRET: 'nested-scope-secret' });
  const nestedLeave = context.enter({ TARGET: '${SECRET}' });

  expect(context.resolve('${TARGET}')).toBe('nested-scope-secret');
  nestedLeave();
  rootLeave();
});

test('renders resolved target variables in optional-step warnings', async () => {
  const target = 'Missing checkout button';
  const program = parseMaestroProgram(
    ['---', '- tapOn:', '    text: ${TARGET}', '    optional: true'].join('\n'),
    { sourcePath: '/flows/optional.yaml' },
  );
  const port: MaestroRuntimePort = {
    execute: vi.fn(async () => {
      throw maestroTestFailure(`Missing ${target}`);
    }),
    observe: vi.fn(async ({ generation }) => ({ generation, matched: true })),
  };

  const result = await executeMaestroProgram(program, port, { env: { TARGET: target } });

  expect(result.warnings).toEqual([expect.stringContaining(target)]);
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
