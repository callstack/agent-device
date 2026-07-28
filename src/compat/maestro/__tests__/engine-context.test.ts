import { expect, test, vi } from 'vitest';
import { maestroTestFailure } from '../compatibility-errors.ts';
import { createMaestroExecutionContext } from '../engine-context.ts';
import type { MaestroRuntimePort } from '../engine-types.ts';
import { parseMaestroProgram } from '../program-ir-parser.ts';
import { executeMaestroProgram } from './runtime-port-fixtures.ts';

test('redacts transitive scoped variables unless explicitly public', () => {
  const context = createMaestroExecutionContext();
  const leave = context.enter({
    TARGET: '${NEXT}',
    NEXT: '${FINAL}',
    FINAL: 'Done',
  });

  expect(context.resolve('${TARGET}')).toBe('Done');
  expect(context.redactionVariables).toEqual([
    { name: 'FINAL', value: 'Done' },
    { name: 'NEXT', value: 'Done' },
    { name: 'TARGET', value: 'Done' },
  ]);
  leave();
});

test('retains shadowed non-public values after nested scopes unwind', () => {
  const context = createMaestroExecutionContext();
  const rootLeave = context.enter({ SECRET: 'nested-scope-secret' });
  const nestedLeave = context.enter({ TARGET: '${SECRET}' });

  expect(context.resolve('${TARGET}')).toBe('nested-scope-secret');
  nestedLeave();
  rootLeave();

  expect(context.redactionVariables).toEqual([
    { name: 'SECRET', value: 'nested-scope-secret' },
    { name: 'TARGET', value: 'nested-scope-secret' },
  ]);
});

test('omits explicitly public variable values from the redaction set', () => {
  const context = createMaestroExecutionContext({}, { TARGET: 'Continue checkout' }, ['TARGET']);

  expect(context.resolve('${TARGET}')).toBe('Continue checkout');
  expect(context.redactionVariables).toEqual([]);
});

test('scrubs optional-step warnings before they enter a successful result', async () => {
  const sentinel = 'optional-maestro-secret';
  const program = parseMaestroProgram(
    ['---', '- tapOn:', '    text: ${SECRET}', '    optional: true'].join('\n'),
    { sourcePath: '/flows/optional.yaml' },
  );
  const port: MaestroRuntimePort = {
    execute: vi.fn(async () => {
      throw maestroTestFailure(`Missing ${sentinel}`);
    }),
    observe: vi.fn(async ({ generation }) => ({ generation, matched: true })),
  };

  const result = await executeMaestroProgram(program, port, { env: { SECRET: sentinel } });

  expect(result.warnings).toEqual([expect.stringContaining('<var:SECRET>')]);
  expect(JSON.stringify(result.warnings)).not.toContain(sentinel);
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
