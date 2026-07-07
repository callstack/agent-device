import { describe, expect, test } from 'vitest';
import type { CliFlags } from '../../cli/parser/cli-flags.ts';
import { metroCliReader, metroCommandDefinition, metroCommandMetadata } from './index.ts';

function flags(overrides: Partial<CliFlags> = {}): CliFlags {
  return overrides as CliFlags;
}

function expectInvalidArgs(fn: () => unknown, messageFragment: string) {
  expect(fn).toThrow(
    expect.objectContaining({
      code: 'INVALID_ARGS',
      message: expect.stringContaining(messageFragment),
    }),
  );
}

describe('metro command interface', () => {
  test('owns public metadata', () => {
    expect(metroCommandMetadata.name).toBe('metro');
    expect(metroCommandDefinition.name).toBe('metro');
  });

  test('reads prepare input from flags', () => {
    expect(
      metroCliReader(
        ['prepare'],
        flags({
          metroProjectRoot: './apps/demo',
          metroPublicBaseUrl: 'https://public.example.test',
          metroProxyBaseUrl: 'https://proxy.example.test',
          metroBearerToken: 'secret',
          metroPreparePort: 9090,
          metroListenHost: '127.0.0.1',
          metroStatusHost: 'localhost',
          metroStartupTimeoutMs: 30_000,
          metroProbeTimeoutMs: 1_500,
          metroRuntimeFile: './runtime.json',
          metroNoReuseExisting: true,
          metroNoInstallDeps: true,
          kind: 'repack',
          tenant: 'tenant-a',
          runId: 'run-a',
          leaseId: 'lease-a',
        }),
      ),
    ).toMatchObject({
      action: 'prepare',
      projectRoot: './apps/demo',
      publicBaseUrl: 'https://public.example.test',
      proxyBaseUrl: 'https://proxy.example.test',
      bearerToken: 'secret',
      port: 9090,
      listenHost: '127.0.0.1',
      statusHost: 'localhost',
      startupTimeoutMs: 30_000,
      probeTimeoutMs: 1_500,
      runtimeFilePath: './runtime.json',
      reuseExisting: false,
      installDependenciesIfNeeded: false,
      kind: 'repack',
      bridgeScope: {
        tenantId: 'tenant-a',
        runId: 'run-a',
        leaseId: 'lease-a',
      },
    });
  });

  test('reads reload input from flags', () => {
    expect(
      metroCliReader(
        ['reload'],
        flags({
          metroHost: '127.0.0.1',
          metroPort: 9090,
          bundleUrl: 'http://localhost:9090/index.bundle',
          metroProbeTimeoutMs: 1_500,
        }),
      ),
    ).toEqual({
      action: 'reload',
      metroHost: '127.0.0.1',
      metroPort: 9090,
      bundleUrl: 'http://localhost:9090/index.bundle',
      timeoutMs: 1_500,
    });
  });

  test('rejects invalid metro input', () => {
    expectInvalidArgs(() => metroCliReader(['start'], flags()), 'metro requires a subcommand');
    expectInvalidArgs(
      () => metroCliReader(['prepare'], flags()),
      'metro prepare requires --public-base-url',
    );
    expectInvalidArgs(
      () => metroCliReader(['prepare'], flags({ metroPublicBaseUrl: 'https://x', kind: 'web' })),
      'metro prepare --kind must be auto, react-native, expo, or repack',
    );
  });
});
