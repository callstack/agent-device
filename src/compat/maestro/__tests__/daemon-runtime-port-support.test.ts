import { expect, test, vi } from 'vitest';
import { invokeMaestroPublicOperation } from '../daemon-runtime-port-support.ts';
import { makeBaseRequest, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('composes operation-specific Maestro flags with the runtime envelope', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  await invokeMaestroPublicOperation(
    {
      baseReq: makeBaseRequest({
        flags: {
          platform: 'ios',
          maestro: { prewarmRunnerBeforeOpen: true },
        },
      }),
      invoke,
      dependencies: makeDependencies(),
      platform: 'ios',
    },
    {
      kind: 'clickSelector',
      selector: { key: 'id', value: 'submit' },
      expectedPoint: { x: 10, y: 20 },
      options: {},
    },
  );

  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      flags: expect.objectContaining({
        maestro: {
          prewarmRunnerBeforeOpen: true,
          allowNonHittableCoordinateFallback: true,
          expectedTapPoint: { x: 10, y: 20 },
        },
      }),
    }),
  );
});

test('preserves diagnostic metadata carried inside daemon error details', async () => {
  const invoke = vi.fn(async () => ({
    ok: false as const,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Developer tools are disabled',
      details: { hint: 'Enable developer tools.', diagnosticId: 'diag-1' },
    },
  }));

  await expect(
    invokeMaestroPublicOperation(
      {
        baseReq: makeBaseRequest(),
        invoke,
        dependencies: makeDependencies(),
        platform: 'ios',
      },
      { kind: 'openLink', link: 'demo://screen', prewarmRunner: true },
    ),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { hint: 'Enable developer tools.', diagnosticId: 'diag-1' },
  });
});
