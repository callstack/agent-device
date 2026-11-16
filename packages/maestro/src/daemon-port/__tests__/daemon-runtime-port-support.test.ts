import {
  commandHostEnvironment,
  withCommandExecutorOverride,
} from '@agent-device/host-kit/command';
import { expect, test, vi } from 'vitest';
import { invokeMaestroPublicOperation } from '../daemon-runtime-port-support.ts';
import { makeRuntimeEnvelope, makeDependencies } from './daemon-runtime-port-fixtures.ts';

test('composes operation-specific Maestro flags with the runtime envelope', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: {} }));

  await invokeMaestroPublicOperation(
    {
      ...makeRuntimeEnvelope({
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

test('marks Maestro hierarchy captures as daemon-private observations', async () => {
  const invoke = vi.fn(async () => ({ ok: true as const, data: { nodes: [] } }));

  await invokeMaestroPublicOperation(
    {
      ...makeRuntimeEnvelope(),
      invoke,
      dependencies: makeDependencies(),
      platform: 'ios',
    },
    { kind: 'snapshot' },
  );

  expect(invoke).toHaveBeenCalledWith(
    expect.objectContaining({
      command: 'snapshot',
      dispatch: expect.objectContaining({ observationOnly: true }),
    }),
  );
});

test('decodes gesture viewport data without imposing a new positive-size policy', async () => {
  const viewport = { x: 0, y: 0, width: 0, height: 0 };
  const invoke = vi.fn(async () => ({ ok: true as const, data: { viewport } }));

  await expect(
    invokeMaestroPublicOperation(
      {
        ...makeRuntimeEnvelope(),
        invoke,
        dependencies: makeDependencies(),
        platform: 'ios',
      },
      { kind: 'gestureViewport' },
    ),
  ).resolves.toEqual(viewport);
});

test('rejects malformed gesture viewport data at the public-operation seam', async () => {
  const invoke = vi.fn(async () => ({
    ok: true as const,
    data: { viewport: { x: 0, y: 0, width: 'invalid', height: 800 } },
  }));

  await expect(
    invokeMaestroPublicOperation(
      {
        ...makeRuntimeEnvelope(),
        invoke,
        dependencies: makeDependencies(),
        platform: 'ios',
      },
      { kind: 'gestureViewport' },
    ),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    message: 'runtime gesture-viewport returned no valid viewport.',
  });
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
        ...makeRuntimeEnvelope(),
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

test('the runtime command adapter enters the supplied host scope', async () => {
  const envelope = makeRuntimeEnvelope();
  const host = { ...envelope.host, env: { ...envelope.host.env, DEVELOPER_DIR: '/fixture/Xcode' } };
  await withCommandExecutorOverride(
    async () => {
      expect(commandHostEnvironment().env.DEVELOPER_DIR).toBe('/fixture/Xcode');
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    async () => {
      await envelope.runCommand({ executable: 'fixture', args: [], host });
    },
  );
});
